// The Claude Code engine's parser and transcript reader on the shapes Claude Code 2.1.325 writes (seen on the real
// binary against a stand-in Messages API): a block's deltas and its final line share an id, task lines, a
// workflow's tree, the queue's lifecycle, limits, a new conversation id; and a conversation read back from its files
// with its subagents, workflows, compacting and title, every unknown line kind skipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import * as P from './protocol.mjs';

const box = sandbox('chateng');
test.after(() => box.cleanup());

const se = (event, parent = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent });

test('a streamed message: deltas and the final block have one id, also when the block\'s line comes before its stop', () => {
  const ev = P.parseLines([
    se({ type: 'message_start', message: { id: 'm1' } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }),
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 40 },
    se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'hm', signature: 'x' }] } },
    se({ type: 'content_block_stop', index: 0 }),
    se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }),
    se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm' } }),
    se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' test","desc' } }),
    se({ type: 'content_block_stop', index: 1 }),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } } },
    { type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 3 },
  ]);
  assert.deepEqual(ev.map((e) => e.kind), ['thinking-delta', 'thinking-delta', 'thinking-delta', 'thinking', 'tool-start', 'tool-start', 'tool', 'usage', 'tool-progress']);
  assert.equal(new Set(ev.filter((e) => e.blockId).map((e) => e.blockId)).size, 1, 'one thinking block');
  assert.equal(ev[2].tokens, 40);
  assert.deepEqual(ev.filter((e) => e.kind === 'tool-start').map((e) => e.title), ['', 'npm test'], 'the title as soon as the command is written');
  assert.equal(ev.find((e) => e.kind === 'tool').toolKind, 'shell');
  assert.equal(ev.find((e) => e.kind === 'usage').contextUsed, 105);
  assert.equal(ev.at(-1).elapsedS, 3);
});

test('tasks: a name, what it does now, its end; background work; a workflow\'s phases and agents', () => {
  const ev = P.parseLines([
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'ta', name: 'Agent', input: { description: 'd', prompt: 'p', model: 'sonnet', effort: 'low', run_in_background: true } }] } },
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'A' }] },
    { type: 'system', subtype: 'task_started', task_id: 'A', tool_use_id: 'ta', description: 'Find it', task_type: 'local_agent', is_backgrounded: true, subagent_type: 'Explore' },
    { type: 'system', subtype: 'task_progress', task_id: 'A', description: 'Reading a.js', usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 }, last_tool_name: 'Read' },
    { type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {}, agent_id: 'A' } },
    { type: 'system', subtype: 'task_updated', task_id: 'A', patch: { status: 'killed' } },
    { type: 'system', subtype: 'task_updated', task_id: 'W', patch: { status: 'failed', error: 'boom' } },
    { type: 'system', subtype: 'task_progress', task_id: 'W', workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'One' }, { type: 'workflow_agent', index: 1, label: 'x', phaseIndex: 1, model: 'm', state: 'done', tokens: 3, toolCalls: 1, durationMs: 2, resultPreview: 'ok' }] },
  ]).filter((e) => e.kind !== 'tool');
  assert.deepEqual(ev[0], { kind: 'tasks-running', ids: ['A'] });
  assert.deepEqual(ev[1], { kind: 'task', taskId: 'A', toolId: 'ta', type: 'agent', title: 'Find it', background: true, agentType: 'Explore', status: 'running', model: 'sonnet', effort: 'low' });
  assert.deepEqual([ev[2].now, ev[2].title, ev[2].lastTool, ev[2].usage], ['Reading a.js', undefined, 'Read', { tokens: 5, tools: 1, ms: 9 }]);
  assert.equal(ev[3].agent, 'ta', 'a subagent\'s ask names the call it nests under');
  assert.equal(ev[4].status, 'stopped');
  assert.deepEqual([ev[5].status, ev[5].error], ['failed', 'boom']);
  assert.deepEqual(ev[6].phases, [{ index: 1, title: 'One' }]);
  assert.deepEqual(ev[6].agents, [{ index: 1, label: 'x', phase: 1, agentId: null, model: 'm', effort: null, state: 'done', tokens: 3, tools: 1, ms: 2, result: 'ok' }]);
});

test('the queue, the owner\'s echoed message, local command output, limits, a new conversation, the title, unknown lines', () => {
  const ev = P.parseLines([
    { type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' },
    { type: 'user', isReplay: true, uuid: 'u1', message: { content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] } },
    { type: 'user', isReplay: true, uuid: 'u2', message: { content: '<local-command-stdout>Set model to haiku</local-command-stdout>' } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', utilization: 1, resetsAt: 5 } },
    { type: 'conversation_reset', new_conversation_id: 'n1', trigger: 'clear' },
    { type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 9, post_tokens: 2 } },
    { type: 'system', subtype: 'session_title_changed', title: 'Name\u001b[1m' },
    { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error: 'overloaded' },
    { type: 'heartbeat' }, { type: 'system', subtype: 'hook_started' }, { type: 'user', isReplay: true, uuid: 'u3', message: { content: '<task-notification>x</task-notification>' } },
    { type: 'control_response', response: { subtype: 'error', request_id: 'h1', error: 'no', error_code: 'bypass_not_launched' } },
  ]);
  assert.deepEqual(ev[0], { kind: 'queue-state', messageId: 'u1', state: 'queued' });
  assert.deepEqual([ev[1].kind, ev[1].messageId, ev[1].text, ev[1].attachments], ['user', 'u1', 'look', [{ type: 'image', name: '', mime: 'image/png' }]]);
  assert.deepEqual([ev[2].kind, ev[2].text], ['notice', 'Set model to haiku']);
  assert.deepEqual(ev[3], { kind: 'limits', window: 'seven_day', status: 'rejected', utilization: 1, resetsAt: 5 });
  assert.deepEqual([ev[4].kind, ev[4].id, ev[4].reason], ['session-changed', 'n1', 'clear']);
  assert.deepEqual([ev[5].reason, ev[5].trigger, ev[5].preTokens], ['compact', 'auto', 9]);
  assert.equal(ev[6].text, 'Name', 'no escape sequences');
  assert.deepEqual(ev[7].retry, { attempt: 2, max: 10, delayMs: 500, error: 'overloaded' });
  assert.deepEqual(ev[8], { kind: 'control-answer', requestId: 'h1', ok: false, response: null, error: 'no', code: 'bypass_not_launched' });
  assert.equal(ev.length, 9, 'unknown lines and machine-made turns give nothing');
});

test('what Claude Code answers by itself (/cost, /context) is a notice, live and read back; the command typed is the owner\'s message', () => {
  const live = P.parseLines([
    { type: 'user', isReplay: true, uuid: 'c1', message: { content: [{ type: 'text', text: '/cost' }] } },
    { type: 'assistant', message: { id: 'syn1', model: '<synthetic>', content: [{ type: 'text', text: 'Total cost:  $0.0088\u001b[0m' }] } },
    { type: 'assistant', message: { id: 'syn2', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] }, error: 'unknown' },
  ]);
  assert.deepEqual([live[0].kind, live[0].text], ['user', '/cost']);
  assert.deepEqual({ ...live[1] }, { kind: 'notice', level: 'info', local: true, text: 'Total cost:  $0.0088', agent: null });
  assert.equal(live.length, 2, 'an API error Claude Code writes as a reply is said by the turn\'s end (error box or limit banner), not twice');
  const dir = path.join(box.root, 'local');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c.jsonl'), [
    { type: 'user', isMeta: true, message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
    { type: 'user', uuid: 'k1', message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>' } },
    { type: 'system', subtype: 'local_command', content: '<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>' },
    { type: 'user', uuid: 'k2', message: { content: '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>' } },
    { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { id: 'e1', model: '<synthetic>', content: [{ type: 'text', text: "API Error: Request rejected (429) · You've hit your usage limit" }] } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  const t = P.transcriptEvents(path.join(dir, 'c.jsonl')).events;
  assert.deepEqual(t.map((e) => [e.kind, e.text, e.local || false]), [['user', '/model sonnet', false], ['notice', 'Set model to `Sonnet 5.5`', true], ['user', '/context', false], ['notice', "API Error: Request rejected (429) · You've hit your usage limit", false]]);
  assert.equal(t[3].level, 'error', 'read back (no turn end there): the error, once, as a notice');
  assert.equal(t[0].messageId, 'k1');
});

test('a conversation read back: subagents nested under their call, a workflow, compacting, the title, unknown lines skipped', () => {
  const dir = path.join(box.root, 'proj');
  fs.mkdirSync(path.join(dir, 'conv', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'conv', 'workflows'), { recursive: true });
  const at = new Date().toISOString();
  const main = [
    { type: 'queue-operation', operation: 'enqueue' }, { type: 'attachment', attachment: {} }, { type: 'file-history-snapshot' }, { type: 'api-request', x: 1 },
    { type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant', timestamp: at, message: { id: 'm1', content: [{ type: 'thinking', thinking: 'plan it' }, { type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'look' } }] } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: 'done looking' }] } },
    { type: 'assistant', timestamp: at, message: { id: 'm2', content: [{ type: 'tool_use', id: 'ed', name: 'Edit', input: { file_path: '/p/a' } }, { type: 'tool_use', id: 'wf', name: 'Workflow', input: {} }] } },
    { type: 'user', timestamp: at, toolUseResult: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ['-a', '+b', '+c'] }] }, message: { content: [{ type: 'tool_result', tool_use_id: 'ed', content: 'updated' }] } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'wf', content: 'Workflow launched in background. Task ID: w77' }] } },
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' }, timestamp: at },
    { type: 'user', isCompactSummary: true, timestamp: at, message: { content: 'summary of it all' } },
    { type: 'custom-title', customTitle: 'Look and fix' },
    { type: 'brand-new-kind', message: { content: 'x' } },
  ];
  fs.writeFileSync(path.join(dir, 'conv.jsonl'), main.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'conv', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look', toolUseId: 'ag', model: 'sonnet', effort: 'low', finished: true }));
  fs.writeFileSync(path.join(dir, 'conv', 'subagents', 'agent-a1.jsonl'), [
    { type: 'user', isSidechain: true, message: { content: 'look' } },
    { type: 'assistant', isSidechain: true, message: { id: 's1', content: [{ type: 'tool_use', id: 'sb', name: 'Grep', input: { pattern: 'x' } }] } },
    { type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'sb', content: '3 hits' }] } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(dir, 'conv', 'workflows', 'wf_1.json'), JSON.stringify({ taskId: 'w77', workflowName: 'checks', status: 'completed', workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'P' }], totalTokens: 50 }));
  const t = P.transcriptEvents(path.join(dir, 'conv.jsonl'));
  assert.deepEqual(t.events.map((e) => `${e.kind}${e.agent ? `@${e.agent}` : ''}`), ['user', 'thinking', 'tool', 'tool@ag', 'tool-result@ag', 'tool-result', 'tool', 'tool', 'tool-result', 'tool-result', 'session-changed']);
  assert.equal(t.events[0].messageId, 'u1');
  assert.deepEqual(t.events[8].diff[0].lines, ['-a', '+b', '+c']);
  assert.equal(t.title, 'Look and fix');
  assert.deepEqual(t.tasks.map((x) => [x.taskId, x.type, x.toolId, x.status]), [['a1', 'agent', 'ag', 'completed'], ['w77', 'workflow', 'wf', 'completed']]);
  assert.deepEqual([t.tasks[0].model, t.tasks[0].effort], ['sonnet', 'low']);
});

test('the engine contract: one engine today, found by id, with what it changes live', async () => {
  const { engineOf, engineIds } = await import('../../src/chat/engines/index.mjs');
  assert.deepEqual(engineIds(), ['claude']);
  const e = engineOf('claude');
  assert.equal(engineOf(undefined), e, 'a chat kept from before engines had names');
  for (const k of ['id', 'label', 'capabilities', 'file', 'exists', 'open', 'transcript', 'sessions']) assert.ok(k in e, k);
  for (const k of ['liveMode', 'liveModel', 'liveEffort', 'ultracode', 'queue', 'stopTask', 'rewind', 'commands', 'usage']) assert.equal(e.capabilities[k], true, k);
});
