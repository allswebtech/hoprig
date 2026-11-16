#!/usr/bin/env node
// A stand-in for Claude Code in headless stream-json mode (no model, no quota), for the coding chat's tests. It
// speaks the protocol seen on Claude Code 2.1.325 (src/chat/protocol.mjs) and writes a transcript where Claude Code
// would, <CLAUDE_CONFIG_DIR>/projects/<slug>/<id>.jsonl. Each message is a small script:
//   "read <file>"    Read (needs no OK) → its text
//   "write <file>"   Write: asks for the OK (can_use_tool) unless the permission mode lets it; writes on "allow"
//   "protect <file>" Write of a sensitive file (.git/, .claude/): asks in every mode but bypassPermissions, also
//                    where edits need no OK; in the default mode it still suggests "edits without asking"
//   "run <command>"  Bash: asks unless the mode or a rule of this session lets it; its suggestion names a settings
//                    file, as Claude Code's does for a command ("npm view x" suggests the rule "npm view *"). A chain
//                    ("cd sub && npm view x") is judged part by part ("cd" needs nothing): it asks with
//                    "subcommandResults" and suggests the rules of the parts no rule covers. The allow rules of
//                    --settings '{"permissions":{"allow":["Bash(npm view *)"]}}' hold from the start.
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
// More (fake-claude-tasks.mjs): "think", "edit <file>", "agent", "bgagent <ms>", "bgsleep", "workflow <ms>",
// "limits", "compact", "title <words>": thinking, a diff, subagents, background tasks and workflows with their task
// lines and the turn Claude Code starts by itself when a background task ends.
// As Claude Code 2.1.325 does with these flags: --include-partial-messages streams text and thinking (stream_event),
// --replay-user-messages echoes each message with its uuid when its turn starts (command_lifecycle says when a
// message was queued, started, completed or taken back), and control requests are answered (initialize,
// set_permission_mode, set_model, apply_flag_settings, stop_task, rewind_files, cancel_async_message,
// get_context_usage, get_usage; anything else: "unsupported_request"). system/init comes at the start of each turn.
// $FAKE_CLAUDE_ARGS: a file that gets one line per start with the arguments it was given, the answers to OK cards
// ({answer}) and the control requests ({control}).
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
// … and by --settings from the start ("Bash(npm view *)" → "Bash:npm view *")
for (const r of (val('--settings') ? JSON.parse(val('--settings')).permissions?.allow : null) || []) {
  const m = /^([^(]+)(?:\((.*)\))?$/.exec(r);
  sessionRules.add(`${m[1]}:${m[2] ?? ''}`);
}
const partial = argv.includes('--include-partial-messages');
const replay = argv.includes('--replay-user-messages');
const canBypass = argv.includes('--allow-dangerously-skip-permissions') || argv.includes('--dangerously-skip-permissions') || wanted === 'bypassPermissions';
let model = val('--model') || 'fake-model';
const flags = { effortLevel: val('--effort'), ultracode: !!(val('--settings') && JSON.parse(val('--settings')).ultracode) };
const changes = []; // files written: { uuid (the message whose turn wrote it), file, before }
let current = null; // the message whose turn runs
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sessionId}.jsonl`);
const record = (type, content, extra = {}) => fs.appendFileSync(transcript, JSON.stringify({ type, isSidechain: false, uuid: `u${Date.now()}${Math.random()}`, timestamp: new Date().toISOString(), sessionId, ...extra, message: { role: type, content } }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let msgs = 0;
/** An assistant message: streamed block by block with --include-partial-messages (as Claude Code: the whole block as
 * an assistant line just before the block's stop), else one line. A subagent's (parent) is never streamed. */
const assistant = (content, { parent = null, noRecord = false } = {}) => {
  if (!noRecord) record('assistant', content);
  const id = `msg_fake_${++msgs}`;
  const line = (c) => out({ type: 'assistant', message: { id, role: 'assistant', content: c, usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 20 } }, parent_tool_use_id: parent, session_id: sessionId });
  if (!partial || parent) return line(content);
  const se = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null, session_id: sessionId, uuid: `se${Math.random()}` });
  se({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
  content.forEach((b, index) => {
    se({ type: 'content_block_start', index, content_block: b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {} } : { type: b.type, [b.type]: '' } });
    const chunks = (t, n) => t.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) || [];
    if (b.type === 'text') for (const t of chunks(b.text, b.text.length > 20_000 ? 50_000 : 5)) se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
    if (b.type === 'thinking') {
      for (const t of chunks(b.thinking, 6)) se({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } });
      out({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12, estimated_tokens_delta: 12, session_id: sessionId });
    }
    if (b.type === 'tool_use') for (const t of chunks(JSON.stringify(b.input), 8)) se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: t } });
    line([b]);
    se({ type: 'content_block_stop', index });
  });
  se({ type: 'message_stop' });
};
const user = (content, { parent = null, result: r = undefined } = {}) => {
  if (!parent) record('user', content, r ? { toolUseResult: r } : {});
  out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: parent, session_id: sessionId, ...(r ? { tool_use_result: r } : {}) });
};
let cost = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.includes('"role":"user"') && !l.includes('tool_result')).length * 0.01 : 0;
const result = (ok, subtype = ok ? 'success' : 'error_during_execution') => {
  cost += 0.01;
  out({
    type: 'result', subtype, is_error: !ok, result: ok ? 'done' : '', session_id: sessionId, total_cost_usd: cost, duration_ms: 1200, num_turns: 1,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 1000 }, modelUsage: { [model]: { inputTokens: 120, outputTokens: 30, costUSD: cost, contextWindow: 200000 } },
  });
};
const init = () => out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode, tools: ['Read', 'Write', 'Bash', 'TaskCreate', 'Agent', 'Workflow'], slash_commands: ['compact', 'cost', 'review'], skills: ['review'], claude_code_version: '9.9.9-fake' });

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

let images = 0;
async function turn(text, content = [{ type: 'text', text }]) {
  record('user', content, current ? { uuid: current } : {});
  images = content.filter((c) => c.type === 'image').length;
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
      const f = answer.updatedInput.file_path;
      changes.push({ uuid: current, file: f, before: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, answer.updatedInput.content);
      user([{ type: 'tool_result', tool_use_id: id, content: `File created successfully at: ${f}` }], { result: { type: 'create', filePath: f, content: answer.updatedInput.content, structuredPatch: [] } });
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
    const ruleOf = (c) => {
      const words = c.split(' ');
      return words.length > 2 ? `${words.slice(0, 2).join(' ')} *` : c;
    };
    const parts = command.split(' && ');
    const chain = parts.length > 1;
    const needed = [...new Set(parts.filter((p) => !/^cd( |$)/.test(p)).map(ruleOf))].filter((r) => judged || !sessionRules.has(`Bash:${r}`));
    let answer = { behavior: 'allow', updatedInput: input };
    if (asks && mode !== 'bypassPermissions' && needed.length) {
      answer = await ask(id, 'Bash', input, {
        description: input.description,
        ...(chain ? { decision_reason_type: 'subcommandResults' } : { decision_reason: judged ? 'Auto mode needs your confirmation for this command.' : 'This command requires approval', decision_reason_type: judged ? 'classifier' : 'other' }),
        permission_suggestions: [{ type: 'addRules', rules: needed.map((r) => ({ toolName: 'Bash', ruleContent: r })), behavior: 'allow', destination: 'localSettings' }],
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
  if ((m = await more(text))) return m;
  assistant([{ type: 'text', text: `echo: ${text}${images ? ` [${images} image${images > 1 ? 's' : ''}]` : ''}` }]);
  return result(true);
}

const queue = []; // { text, content, uuid }
let busy = false;
const lifecycle = (uuid, state) => uuid && out({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: `lc${Math.random()}`, session_id: sessionId });
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const msg = queue.shift();
    current = msg.uuid;
    lifecycle(msg.uuid, 'started');
    init();
    if (replay) out({ type: 'user', message: { role: 'user', content: msg.content }, parent_tool_use_id: null, session_id: sessionId, uuid: msg.uuid, isReplay: true });
    await turn(msg.text, msg.content);
    lifecycle(msg.uuid, 'completed');
    current = null;
  }
  busy = false;
}
/** A turn of its own, as Claude Code starts one when a background task ends (no user line). */
async function ownTurn(fn) {
  while (busy) await new Promise((r) => setTimeout(r, 20));
  busy = true;
  init();
  await fn();
  busy = false;
  pump();
}
const answerControl = (m, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
const refuse = (m, error, code) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error, error_code: code } });
function control(m) {
  const r = m.request;
  if (process.env.FAKE_CLAUDE_ARGS && r.subtype !== 'interrupt') fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ control: r }) + '\n');
  switch (r.subtype) {
    case 'interrupt':
      // An OK it still waits for is taken back, then the stop is confirmed and the turn ends.
      for (const [rid, resolve] of waiting) {
        out({ type: 'control_cancel_request', request_id: rid });
        resolve({ behavior: 'deny', stopped: true });
      }
      waiting.clear();
      answerControl(m, { still_queued: [] });
      onInterrupt?.();
      return;
    case 'initialize':
      return answerControl(m, { commands: [{ name: 'compact', description: 'Clear the history but keep a summary', argumentHint: '', builtin: true }, { name: 'review', description: 'Review the changes', argumentHint: '[what]', builtin: false }], models: [{ value: 'default' }, { value: 'haiku' }], pid: process.pid });
    case 'set_permission_mode':
      if (r.mode === 'bypassPermissions' && !canBypass) return refuse(m, 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions', 'bypass_not_launched');
      setMode(r.mode);
      return answerControl(m, { mode: r.mode });
    case 'set_model':
      model = r.model || 'fake-default';
      out({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` }, isReplay: true, uuid: `rp${Math.random()}`, session_id: sessionId });
      return answerControl(m, { model });
    case 'apply_flag_settings':
      // Without an "ultracode" key an effort change turns it off.
      if ('effortLevel' in r.settings) flags.ultracode = !!r.settings.ultracode;
      Object.assign(flags, r.settings);
      return answerControl(m, {});
    case 'get_settings':
      return answerControl(m, { applied: { model, effort: flags.effortLevel, ultracode: flags.ultracode } });
    case 'stop_task':
      return stopTask(r.task_id) ? answerControl(m, {}) : refuse(m, 'No such task', 'not_found');
    case 'rewind_files': {
      if (process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING !== '1') return answerControl(m, { canRewind: false, error: 'File checkpointing is not enabled' });
      const at = changes.findIndex((c) => c.uuid === r.user_message_id);
      if (at < 0) return answerControl(m, { canRewind: false, error: 'No changes since that message' });
      const undo = changes.slice(at);
      if (!r.dry_run) {
        for (const c of undo.reverse()) (c.before === null ? fs.rmSync(c.file, { force: true }) : fs.writeFileSync(c.file, c.before));
        changes.splice(at);
      }
      return answerControl(m, { canRewind: true, filesChanged: [...new Set(undo.map((c) => c.file))], insertions: 0, deletions: undo.length });
    }
    case 'cancel_async_message': {
      const i = queue.findIndex((q) => q.uuid === r.message_uuid);
      if (i >= 0) {
        queue.splice(i, 1);
        lifecycle(r.message_uuid, 'cancelled');
      }
      return answerControl(m, { cancelled: i >= 0 });
    }
    case 'get_context_usage':
      return answerControl(m, { totalTokens: 21000, maxTokens: 200000, percentage: 10.5, categories: [] });
    case 'get_usage':
      return answerControl(m, { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { status: 'allowed', utilization: 0.42, resetsAt: 1900000000 } } });
    default:
      return refuse(m, `Unsupported control request subtype: ${r.subtype}`, 'unsupported_request');
  }
}
const { more, stopTask } = await import('./fake-claude-tasks.mjs').then((x) => x.tasks({ out, assistant, user, tool, result, init, sessionId, ownTurn, mode: () => mode, onStop: (f) => (onInterrupt = f) }));

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'user') {
    const content = typeof m.message.content === 'string' ? [{ type: 'text', text: m.message.content }] : m.message.content;
    const text = (content.find((c) => c.type === 'text') || { text: '' }).text;
    if (busy) lifecycle(m.uuid, 'queued');
    queue.push({ text, content, uuid: m.uuid || null });
    pump();
  } else if (m.type === 'control_response') {
    if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ answer: m.response.response }) + '\n');
    const r = waiting.get(m.response.request_id);
    waiting.delete(m.response.request_id);
    r?.(m.response.response);
  } else if (m.type === 'control_request') control(m);
}).on('close', () => {
  if (!process.env.FAKE_CLAUDE_STUBBORN) process.exit(0);
});
if (process.env.FAKE_CLAUDE_STUBBORN) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
