#!/usr/bin/env node
// A stand-in for Claude Code in headless stream-json mode (no model, no quota), for the coding chat's tests. It
// speaks the protocol seen on Claude Code 2.1.325 (src/chat/protocol.mjs) and writes a transcript where Claude Code
// would, <CLAUDE_CONFIG_DIR>/projects/<slug>/<id>.jsonl. Each message is a small script:
//   "read <file>"    Read (needs no OK) → its text
//   "write <file>"   Write: asks for the OK (can_use_tool) unless the permission mode lets it; writes on "allow"
//   "sleep"          Bash that runs until an interrupt arrives
//   "task <words>"   TaskCreate → "Task #1 created successfully"
//   "big"            a 200 KB reply, then a usage-limit result, then it exits at once (code 1)
//   anything else    "echo: <message>"
// $FAKE_CLAUDE_ARGS: a file that gets one line per start with the arguments it was given (and the answers to OK cards).
// $FAKE_CLAUDE_STUBBORN=1: it keeps running when its input ends and ignores SIGTERM (only SIGKILL ends it).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(argv) + '\n');
const sessionId = val('--resume') || val('--session-id');
const mode = val('--permission-mode') || 'default';
const asks = val('--permission-prompt-tool') === 'stdio';
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sessionId}.jsonl`);
const record = (type, content) => fs.appendFileSync(transcript, JSON.stringify({ type, isSidechain: false, uuid: `u${Date.now()}${Math.random()}`, timestamp: new Date().toISOString(), sessionId, message: { role: type, content } }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const assistant = (content) => {
  record('assistant', content);
  out({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: sessionId });
};
const user = (content) => {
  record('user', content);
  out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId });
};
let cost = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.includes('"role":"user"') && !l.includes('tool_result')).length * 0.01 : 0;
const result = (ok, subtype = ok ? 'success' : 'error_during_execution') => {
  cost += 0.01;
  out({ type: 'result', subtype, is_error: !ok, result: ok ? 'done' : '', session_id: sessionId, total_cost_usd: cost, duration_ms: 1200, num_turns: 1, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 1000 } });
};
out({ type: 'system', subtype: 'init', session_id: sessionId, model: val('--model') || 'fake-model', permissionMode: mode, tools: ['Read', 'Write', 'Bash', 'TaskCreate'] });

const waiting = new Map(); // request id → resolve
let onInterrupt = null;
let n = 0;
const tool = (name, input) => {
  const id = `toolu_${++n}`;
  assistant([{ type: 'tool_use', id, name, input }]);
  return id;
};

async function turn(text) {
  record('user', [{ type: 'text', text }]);
  let m;
  if ((m = /^read (\S+)/.exec(text))) {
    const id = tool('Read', { file_path: path.resolve(m[1]) });
    user([{ type: 'tool_result', tool_use_id: id, content: fs.readFileSync(m[1], 'utf8') }]);
    assistant([{ type: 'text', text: `The file says: **${fs.readFileSync(m[1], 'utf8').trim()}**` }]);
    return result(true);
  }
  if ((m = /^write (\S+)/.exec(text))) {
    const input = { file_path: path.resolve(m[1]), content: 'written by the fake\n' };
    const id = tool('Write', input);
    let answer = { behavior: 'allow', updatedInput: input };
    if (asks && !['bypassPermissions', 'acceptEdits'].includes(mode)) {
      const rid = `req-${n}`;
      out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input, description: path.basename(m[1]), tool_use_id: id, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
      answer = await new Promise((resolve) => waiting.set(rid, resolve));
    }
    if (answer.behavior === 'allow') {
      fs.writeFileSync(answer.updatedInput.file_path, answer.updatedInput.content);
      user([{ type: 'tool_result', tool_use_id: id, content: `File created successfully at: ${answer.updatedInput.file_path}` }]);
      assistant([{ type: 'text', text: 'Written.' }]);
    } else {
      user([{ type: 'tool_result', tool_use_id: id, is_error: true, content: answer.message }]);
      assistant([{ type: 'text', text: 'I did not write it.' }]);
    }
    return result(true);
  }
  if (text === 'sleep') {
    const id = tool('Bash', { command: 'sleep 600', description: 'wait a long time' });
    await new Promise((resolve) => (onInterrupt = resolve));
    user([{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' }]);
    user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
    return result(false);
  }
  if (text === 'big') {
    assistant([{ type: 'text', text: 'x'.repeat(200_000) }]);
    // As Claude Code does: its output is written out to the pipe, then it exits at once. Whether the reader has
    // read it all by the time it sees the exit is the reader's business.
    const last = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit · resets 5pm", session_id: sessionId, total_cost_usd: cost, num_turns: 1 }) + '\n';
    process.stdout.write(last, () => process.exit(1));
    return new Promise(() => {});
  }
  if ((m = /^task (.+)/.exec(text))) {
    const id = tool('TaskCreate', { subject: m[1], activeForm: `Doing ${m[1]}` });
    user([{ type: 'tool_result', tool_use_id: id, content: `Task #1 created successfully: ${m[1]}` }]);
    return result(true);
  }
  assistant([{ type: 'text', text: `echo: ${text}` }]);
  return result(true);
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
  const m = JSON.parse(l);
  if (m.type === 'user') {
    queue.push(m.message.content[0].text);
    pump();
  } else if (m.type === 'control_response') {
    if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ answer: m.response.response }) + '\n');
    const r = waiting.get(m.response.request_id);
    waiting.delete(m.response.request_id);
    r?.(m.response.response);
  } else if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
    onInterrupt?.();
  }
}).on('close', () => {
  if (!process.env.FAKE_CLAUDE_STUBBORN) process.exit(0);
});
if (process.env.FAKE_CLAUDE_STUBBORN) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
