#!/usr/bin/env node
// A stand-in for Claude Code in headless stream-json mode (no model, no quota), for the coding chat's tests. It
// speaks the protocol seen on Claude Code 2.1.325 (src/chat/protocol.mjs) and writes a transcript where Claude Code
// would, <CLAUDE_CONFIG_DIR>/projects/<slug>/<id>.jsonl. Each message is a small script:
//   "read <file>"    Read (needs no OK) → its text
//   "write <file>"   Write: asks for the OK (can_use_tool) unless the permission mode lets it; writes on "allow"
//   "protect <file>" Write of a sensitive file (.git/, .claude/): asks in every mode but bypassPermissions, also
//                    where edits need no OK; in the default mode it still suggests "edits without asking"
//   "run <command>"  Bash: asks unless the mode or a rule of this session lets it; its suggestion names a settings
//                    file, as Claude Code's does for a command ("npm view x" suggests the rule "npm view *")
//   "judged <cmd>"   Bash as "run", but asked for a reason no rule is known to settle (decision_reason_type
//                    "classifier"): asks every time unless the mode is bypassPermissions
//   "reads <a> <b>"  two Reads outside the project at once: two asks are open together
//   "sleep"          Bash that runs until an interrupt arrives
//   "task <words>"   TaskCreate → "Task #1 created successfully"
//   "big"            a 200 KB reply, then a usage-limit result, then it exits at once (code 1)
//   anything else    "echo: <message>"
// What asks in every mode, bypassPermissions too, as Claude Code does:
//   "question"       AskUserQuestion (the card is the answer)
//   "plan <file>"    EnterPlanMode (asks nothing; the mode is "plan" from then on), a Write of <file> (asks: plan
//                    mode), ExitPlanMode with the plan (the card is the answer; "allow" gives the first mode back)
//   "askrule <cmd>"  Bash that an "ask" rule of the settings covers
//   "hook <file>"    Write on which a hook answered "ask"
//   "rm <dir>"       Bash "rm -rf $DIR/*": Claude Code's stop before a delete that could empty the disk
// and what never asks: "denied <file>", a Write that a deny rule of the settings covers (refused in every mode).
// $FAKE_CLAUDE_ARGS: a file that gets one line per start with the arguments it was given (and the answers to OK cards).
// $FAKE_CLAUDE_STUBBORN=1: it keeps running when its input ends and ignores SIGTERM (only SIGKILL ends it).
// $FAKE_CLAUDE_NO_BYPASS=1: the settings turn bypassPermissions off: it starts in the default mode instead.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(argv) + '\n');
const sessionId = val('--resume') || val('--session-id');
// "manual" is the flag's word for the mode Claude Code reports as "default".
const wanted = val('--permission-mode') || 'default';
const startMode = wanted === 'manual' || (wanted === 'bypassPermissions' && process.env.FAKE_CLAUDE_NO_BYPASS) ? 'default' : wanted;
let mode = startMode;
const asks = val('--permission-prompt-tool') === 'stdio';
const sessionRules = new Set(); // "Bash:npm view *": allowed for this process by an answer's updatedPermissions
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
const setMode = (m) => {
  mode = m;
  out({ type: 'system', subtype: 'status', status: null, permissionMode: m, session_id: sessionId });
};
/** Ask for the OK of tool use `id`; resolves with the answer. `more`: the request's other fields. */
function ask(id, name, input, more = {}) {
  const rid = `req-${id}`;
  out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: name, display_name: name, input, tool_use_id: id, ...more } });
  return new Promise((resolve) => waiting.set(rid, resolve));
}
/** What an "allow" adds for this process (updatedPermissions). */
function learn(answer) {
  for (const u of answer.updatedPermissions || []) {
    if (u.destination !== 'session') continue;
    if (u.type === 'setMode') setMode(u.mode);
    if (u.type === 'addRules' && u.behavior === 'allow') for (const r of u.rules) sessionRules.add(`${r.toolName}:${r.ruleContent ?? ''}`);
  }
}
const refused = (id, answer) => user([{ type: 'tool_result', tool_use_id: id, is_error: true, content: answer.message || 'The user doesn\'t want to proceed with this tool use.' }]);
/** One Bash call that needs the OK in every mode; `more` says why. */
async function guarded(command, more) {
  const input = { command, description: 'a command' };
  const id = tool('Bash', input);
  const answer = await ask(id, 'Bash', input, { description: input.description, ...more });
  if (answer.behavior === 'allow') user([{ type: 'tool_result', tool_use_id: id, content: `ran: ${command}` }]);
  else refused(id, answer);
  if (answer.stopped) return stopped();
  assistant([{ type: 'text', text: answer.behavior === 'allow' ? 'Done.' : 'I did not run it.' }]);
  return result(true);
}
function stopped() {
  user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
  return result(false);
}

async function turn(text) {
  record('user', [{ type: 'text', text }]);
  let m;
  if ((m = /^read (\S+)/.exec(text))) {
    const id = tool('Read', { file_path: path.resolve(m[1]) });
    user([{ type: 'tool_result', tool_use_id: id, content: fs.readFileSync(m[1], 'utf8') }]);
    assistant([{ type: 'text', text: `The file says: **${fs.readFileSync(m[1], 'utf8').trim()}**` }]);
    return result(true);
  }
  if ((m = /^(write|protect) (\S+)/.exec(text))) {
    const input = { file_path: path.resolve(m[2]), content: 'written by the fake\n' };
    const id = tool('Write', input);
    const edits = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
    let answer = { behavior: 'allow', updatedInput: input };
    if (asks && m[1] === 'protect' && mode !== 'bypassPermissions') {
      answer = await ask(id, 'Write', input, {
        description: m[2], permission_suggestions: mode === 'acceptEdits' ? [] : [edits],
        decision_reason: `Claude requested permissions to edit ${input.file_path} which is a sensitive file.`, decision_reason_type: 'safetyCheck', classifier_approvable: true,
      });
    } else if (asks && !['bypassPermissions', 'acceptEdits'].includes(mode)) {
      answer = await ask(id, 'Write', input, { description: path.basename(m[2]), permission_suggestions: [edits], server_policy_ask_only: true });
    }
    if (answer.behavior === 'allow') {
      learn(answer);
      fs.mkdirSync(path.dirname(answer.updatedInput.file_path), { recursive: true });
      fs.writeFileSync(answer.updatedInput.file_path, answer.updatedInput.content);
      user([{ type: 'tool_result', tool_use_id: id, content: `File created successfully at: ${answer.updatedInput.file_path}` }]);
      assistant([{ type: 'text', text: 'Written.' }]);
    } else {
      refused(id, answer);
      if (answer.stopped) return stopped();
      assistant([{ type: 'text', text: 'I did not write it.' }]);
    }
    return result(true);
  }
  if ((m = /^(run|judged) (.+)/.exec(text))) {
    const judged = m[1] === 'judged';
    const command = m[2];
    const input = { command, description: 'a command' };
    const id = tool('Bash', input);
    // Claude Code's rule for a command: its first two words and "*", or the command itself when it is that short.
    const words = command.split(' ');
    const rule = words.length > 2 ? `${words.slice(0, 2).join(' ')} *` : command;
    let answer = { behavior: 'allow', updatedInput: input };
    if (asks && mode !== 'bypassPermissions' && (judged || !sessionRules.has(`Bash:${rule}`))) {
      answer = await ask(id, 'Bash', input, {
        description: input.description, decision_reason: judged ? 'Auto mode needs your confirmation for this command.' : 'This command requires approval', decision_reason_type: judged ? 'classifier' : 'other',
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: rule }], behavior: 'allow', destination: 'localSettings' }],
      });
    }
    if (answer.behavior === 'allow') {
      learn(answer);
      user([{ type: 'tool_result', tool_use_id: id, content: `ran: ${command}` }]);
      assistant([{ type: 'text', text: 'Done.' }]);
    } else {
      refused(id, answer);
      if (answer.stopped) return stopped();
      assistant([{ type: 'text', text: 'I did not run it.' }]);
    }
    return result(true);
  }
  if ((m = /^reads (\S+) (\S+)/.exec(text))) {
    const files = [m[1], m[2]].map((f) => path.resolve(f));
    const ids = files.map((f) => tool('Read', { file_path: f }));
    const answers = await Promise.all(files.map((f, i) => ask(ids[i], 'Read', { file_path: f }, {
      description: f, decision_reason: 'Path is outside allowed working directories', decision_reason_type: 'workingDir', server_policy_ask_only: true,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: `/${path.dirname(f)}/**` }], behavior: 'allow', destination: 'session' }],
    })));
    answers.forEach((a, i) => (a.behavior === 'allow' ? user([{ type: 'tool_result', tool_use_id: ids[i], content: fs.readFileSync(files[i], 'utf8') }]) : refused(ids[i], a)));
    if (answers.some((a) => a.stopped)) return stopped();
    assistant([{ type: 'text', text: `Read ${answers.filter((a) => a.behavior === 'allow').length} of 2.` }]);
    return result(true);
  }
  if (text === 'question') {
    const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] };
    const id = tool('AskUserQuestion', input);
    const answer = await ask(id, 'AskUserQuestion', input, { requires_user_interaction: true });
    if (answer.behavior === 'allow') {
      const said = Object.entries(answer.updatedInput.answers || {}).map(([q, a]) => `"${q}"="${a}"`).join(', ');
      user([{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: ${said}.` }]);
      assistant([{ type: 'text', text: `You chose ${Object.values(answer.updatedInput.answers || {}).join(', ')}.` }]);
    } else {
      refused(id, answer);
      if (answer.stopped) return stopped();
      assistant([{ type: 'text', text: 'Tell me in a message, then.' }]);
    }
    return result(true);
  }
  if ((m = /^plan (\S+)/.exec(text))) {
    const enter = tool('EnterPlanMode', {});
    setMode('plan');
    user([{ type: 'tool_result', tool_use_id: enter, content: 'Entered plan mode.' }]);
    const input = { file_path: path.resolve(m[1]), content: 'written in plan mode\n' };
    const w = tool('Write', input);
    const a1 = await ask(w, 'Write', input, { description: path.basename(m[1]), decision_reason_type: 'mode' });
    if (a1.behavior === 'allow') {
      fs.writeFileSync(input.file_path, input.content);
      user([{ type: 'tool_result', tool_use_id: w, content: `File created successfully at: ${input.file_path}` }]);
    } else refused(w, a1);
    if (a1.stopped) return stopped();
    const plan = { plan: '# The plan\n\n1. Add the thing\n2. Test it\n' };
    const x = tool('ExitPlanMode', plan);
    const a2 = await ask(x, 'ExitPlanMode', plan, { requires_user_interaction: true });
    if (a2.behavior === 'allow') {
      setMode(startMode);
      user([{ type: 'tool_result', tool_use_id: x, content: 'User has approved your plan. You can now start coding.' }]);
      assistant([{ type: 'text', text: 'The plan is approved.' }]);
    } else {
      refused(x, a2);
      if (a2.stopped) return stopped();
      assistant([{ type: 'text', text: 'I keep planning.' }]);
    }
    return result(true);
  }
  if ((m = /^askrule (.+)/.exec(text))) return guarded(m[1], { decision_reason_type: 'rule', decision_reason_rule_source: 'userSettings', server_policy_ask_only: false });
  if ((m = /^rm (\S+)/.exec(text))) {
    return guarded(`rm -rf $${m[1]}/*`, {
      permission_suggestions: [], decision_reason: `Dangerous rm operation on possibly-empty variable path: $${m[1]}/*`, decision_reason_type: 'safetyCheck',
      classifier_approvable: false, suppress_always_allow_rule: true,
    });
  }
  if ((m = /^hook (\S+)/.exec(text))) {
    const input = { file_path: path.resolve(m[1]), content: 'written by the fake\n' };
    const id = tool('Write', input);
    const answer = await ask(id, 'Write', input, { description: path.basename(m[1]), decision_reason: 'the hook wants a person to look', decision_reason_type: 'hook', decision_reason_hook_event: 'PreToolUse', decision_reason_hook_source: 'settings' });
    if (answer.behavior === 'allow') {
      fs.writeFileSync(input.file_path, input.content);
      user([{ type: 'tool_result', tool_use_id: id, content: `File created successfully at: ${input.file_path}` }]);
    } else refused(id, answer);
    if (answer.stopped) return stopped();
    assistant([{ type: 'text', text: answer.behavior === 'allow' ? 'Written.' : 'I did not write it.' }]);
    return result(true);
  }
  if ((m = /^denied (\S+)/.exec(text))) {
    const id = tool('Write', { file_path: path.resolve(m[1]), content: 'x\n' });
    user([{ type: 'tool_result', tool_use_id: id, is_error: true, content: '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>' }]);
    assistant([{ type: 'text', text: 'Your settings do not let me write there.' }]);
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
    // An OK it still waits for is taken back, then the stop is confirmed and the turn ends.
    for (const [rid, resolve] of waiting) {
      out({ type: 'control_cancel_request', request_id: rid });
      resolve({ behavior: 'deny', stopped: true });
    }
    waiting.clear();
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
