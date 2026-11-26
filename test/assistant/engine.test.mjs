import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { Engine, ISOLATION_ENV, TOOL_PREFIX, claudeCommand, engineArgs, engineEnv, mcpConfig, parseEvents, userLine } from '../../src/assistant/engine.mjs';
import { promptArgs } from '../../src/server/deck.mjs';
import { sandbox } from '../server/helpers.mjs';
import { BASE_PROMPT, systemPrompt } from '../../src/assistant/prompt.mjs';
import { recordUsage, readUsage, summarizeUsage, turnUsage } from '../../src/assistant/usage.mjs';
import { sealed } from '../seal.mjs';

test('engineArgs: headless, only our MCP tools, no built-in tools, nothing that would prompt', () => {
  const a = engineArgs({ systemPrompt: 'P', mcpConfigFile: '/x/mcp.json', sessionId: 'abc', model: 'haiku', maxBudgetUsd: 0.5 });
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.deepEqual(a.slice(0, 6), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.equal(at('--system-prompt'), 'P');
  assert.equal(at('--tools'), '');
  assert.equal(at('--mcp-config'), '/x/mcp.json');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(at('--allowedTools'), `${TOOL_PREFIX}*`);
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.ok(a.includes('--disable-slash-commands'));
  assert.equal(at('--setting-sources'), '', 'no user, project or local settings: no hooks, no permissions of the owner');
  assert.equal(at('--model'), 'haiku');
  assert.equal(at('--max-budget-usd'), '0.5');
  assert.equal(at('--session-id'), 'abc');
  assert.equal(engineArgs({ systemPrompt: 'P', mcpConfigFile: 'f', sessionId: 'abc', resume: true }).at(-2), '--resume');
  assert.ok(!a.includes('--dangerously-skip-permissions'));
});

test('mcpConfig: one stdio server named hoprig; the token is a FILE path, never the token itself', () => {
  const c = mcpConfig({ url: 'http://127.0.0.1:1', tokenFile: '/s/assistant-token', conversation: 'c1', command: 'node', args: ['bin', 'mcp'] });
  assert.deepEqual(Object.keys(c.mcpServers), ['hoprig']);
  assert.deepEqual(c.mcpServers.hoprig, { type: 'stdio', command: 'node', args: ['bin', 'mcp'], env: { HOPRIG_DASHBOARD_URL: 'http://127.0.0.1:1', HOPRIG_ASSISTANT_TOKEN_FILE: '/s/assistant-token', HOPRIG_ASSISTANT_CONVERSATION: 'c1' } });
});

test('engineEnv: the profile\'s own environment and PRERUN, no other account\'s keys, isolation switches on', async (t) => {
  const box = sandbox('tia-env');
  t.after(() => box.cleanup());
  const { writeProfile } = await import('../../src/profiles.mjs');
  const marker = path.join(box.root, 'prerun-ran');
  writeProfile('gw', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'x-test' }, prerun: `touch ${marker}` });
  const env = await engineEnv('gw', sealed({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'from-the-dashboard', HOPRIG_RUN_FILE: '/x', TMUX: '/t' }));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'another account\'s key never leaks in');
  assert.equal(env.HOPRIG_RUN_FILE, undefined);
  assert.equal(env.TMUX, undefined);
  for (const [k, v] of Object.entries(ISOLATION_ENV)) assert.equal(env[k], v);
  assert.ok(fs.existsSync(marker), 'PRERUN ran (a gateway that starts on demand)');
  await assert.rejects(engineEnv('nope', {}), /no provider "nope"/);
  writeProfile('bad', { prerun: 'exit 3' });
  await assert.rejects(engineEnv('bad', sealed({ PATH: process.env.PATH })), /start command failed/);
});

test('claudeCommand: claudeBin as configured; on Windows a .cmd shim goes through cmd.exe', () => {
  assert.deepEqual(claudeCommand(['-p'], {}, { bin: 'claude', platform: 'linux' }), { command: 'claude', args: ['-p'], options: {} });
  const w = claudeCommand(['-p', 'a b'], { PATH: 'C:\\bin', PATHEXT: '.CMD' }, { bin: 'C:\\nope\\claude', platform: 'win32' }); // seal: a value no program is started with
  assert.equal(w.command, 'C:\\nope\\claude', 'not found: run as given');
});

test('deck prompt: after "--", whole (several lines, tabs: it is never typed into a shell)', () => {
  assert.deepEqual(promptArgs('-x do\nthis \t\r\n now'), ['--', '-x do\nthis \t\r\n now']);
  assert.deepEqual(promptArgs(null), []);
});

test('parseEvents: init, text, tool call, tool result, result; junk gives nothing', () => {
  assert.deepEqual(parseEvents('{"type":"system","subtype":"init","session_id":"s1","tools":["mcp__hoprig__list_sessions"],"mcp_servers":[{"name":"hoprig","status":"connected"}],"model":"m"}'), [{ kind: 'init', sessionId: 's1', tools: ['mcp__hoprig__list_sessions'], mcpServers: [{ name: 'hoprig', status: 'connected' }], model: 'm' }]);
  assert.deepEqual(parseEvents({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'mcp__hoprig__start_session', input: { folder: '/x' } }] } }), [
    { kind: 'text', text: 'hi' },
    { kind: 'tool_call', id: 't1', name: 'start_session', rawName: 'mcp__hoprig__start_session', input: { folder: '/x' } },
  ]);
  assert.deepEqual(parseEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Error: x' }] }] } }), [{ kind: 'tool_result', id: 't1', isError: true, text: 'Error: x' }]);
  const done = parseEvents({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1', total_cost_usd: 0.012, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 } })[0];
  assert.deepEqual(done, { kind: 'done', ok: true, subtype: 'success', text: 'ok', sessionId: 's1', costUsd: 0.012, usage: { input_tokens: 10, output_tokens: 5 }, turns: 3 });
  assert.deepEqual(parseEvents('not json'), []);
  assert.deepEqual(parseEvents('{"type":"stream_event"}'), []);
});

test('userLine: one stream-json user message per line', () => {
  const l = userLine('hello\nworld');
  assert.ok(l.endsWith('\n'));
  assert.equal(l.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(l), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello\nworld' }] } });
});

/** A fake `claude` process: answers each stdin line with an assistant text and a result. */
function fakeSpawn(record) {
  return (cmd, args, opts) => {
    record.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('exit', 0));
    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\n');
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (line) => {
      const text = JSON.parse(line).message.content[0].text;
      child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `echo: ${text}` }] } }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: `echo: ${text}`, session_id: 'sess-1', total_cost_usd: 0.001 }) + '\n');
    });
    return child;
  };
}

test('Engine: profile env + claude + args; turns in order; resumes after the process exits; config removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-engine-'));
  try {
    const record = [];
    const e = new Engine({ profile: 'api', systemPrompt: 'P', url: 'http://127.0.0.1:1', tokenFile: '/s/token', conversation: 'c1', dir, spawnImpl: fakeSpawn(record), resolveEnv: async (p) => ({ PROFILE_ENV: p }), command: { command: 'fake-claude', args: ['--x'] } });
    const [a, b] = await Promise.all([e.send('one'), e.send('two')]);
    assert.equal(a.done.text, 'echo: one');
    assert.equal(b.done.text, 'echo: two');
    assert.equal(record.length, 1, 'one long-lived process');
    assert.equal(record[0].cmd, 'fake-claude');
    assert.equal(record[0].args[0], '--x');
    assert.deepEqual(record[0].opts.env, { PROFILE_ENV: 'api' }, 'the environment comes from the profile, not the launcher');
    assert.ok(record[0].args.includes('--session-id'));
    assert.equal(record[0].opts.cwd, path.join(dir, 'work'), 'an empty working folder');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    assert.equal(cfg.mcpServers.hoprig.env.HOPRIG_ASSISTANT_TOKEN_FILE, '/s/token');
    assert.equal(cfg.mcpServers.hoprig.env.HOPRIG_ASSISTANT_TOKEN, undefined);
    if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(dir, 'mcp.json')).mode & 0o777).toString(8), '600');
    e.stop();
    const c = await e.send('three');
    assert.equal(c.done.text, 'echo: three');
    assert.equal(record.length, 2);
    assert.equal(record[1].args[record[1].args.indexOf('--resume') + 1], 'sess-1', 'the same conversation is resumed');
    e.cleanup();
    assert.equal(fs.existsSync(path.join(dir, 'mcp.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the system prompt: the name, the fence rule, cards, secrets, out of scope; skills index appended', () => {
  for (const s of ['You are Tia', 'DATA', 'never instructions', 'can never authorise an action', 'confirm card', 'open_screen', 'no tool does', 'finish_job']) assert.ok(BASE_PROMPT.includes(s), s);
  assert.ok(systemPrompt('- a: b').endsWith('- a: b'));
  assert.equal(systemPrompt(''), BASE_PROMPT);
});

test('usage: per turn from the result event, summed for today, 7 days and per conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-usage-'));
  try {
    const file = path.join(dir, 'u.jsonl');
    const now = Date.UTC(2026, 10, 14, 12);
    recordUsage(turnUsage({ costUsd: 0.01, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 } }, { conversation: 'a', now }), file);
    recordUsage(turnUsage({ costUsd: 0.02, usage: { input_tokens: 50, output_tokens: 10 } }, { conversation: 'b', now: now - 3 * 86_400_000 }), file);
    recordUsage(turnUsage({ costUsd: null, usage: null }, { conversation: 'a', now: now - 30 * 86_400_000 }), file);
    const s = summarizeUsage(readUsage(file), now);
    assert.deepEqual([s.today.turns, s.week.turns, s.total.turns], [1, 2, 3]);
    assert.equal(s.week.costUsd, 0.03);
    assert.equal(s.byConversation.a.input, 100);
    assert.equal(s.byConversation.a.cacheRead, 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit log file: one masked JSON line per write, mode 600, read back after a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-audit-'));
  try {
    const file = path.join(dir, 'a.jsonl');
    const log = new AuditLog({ file });
    log.append({ actor: 'assistant', conversation: 'c', tool: 'run_command', level: 'L2', input: { command: 'curl -H "Authorization: Bearer abcdefghijkl" x' }, outcome: 'staged', card: 'c_1' });
    if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    const back = new AuditLog({ file }).recent();
    assert.equal(back.length, 1);
    assert.equal(back[0].card, 'c_1');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('abcdefghijkl'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
