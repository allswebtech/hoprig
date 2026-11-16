// The OpenCode engine of the chat, against what OpenCode's real server sent (fixtures/opencode-events.jsonl, recorded
// from OpenCode 2.3 through Hoprig's own server; replayed by a stand-in server): a streamed answer, a new file and an
// edit with their diffs, an OK allowed, allowed in this chat and refused, Stop, a queued message taken back, the
// conversation read back after the chat closed, bypass, and an OK whose call the chat did not see whole.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MESSAGES, RECORDED, SESSION_ID, recordedTurns, standIn, standInOpts } from './fixtures/opencode-standin.mjs';

const CWD = '/work/proj';

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function chatOn(s, o = {}) {
  const { Chat } = await import('../../src/chat/chat.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-occhat-'));
  const c = new Chat({ id: '7d9c2a4e-1b3f-4c5d-8e6f-0a1b2c3d4e5f', engine: 'opencode', cwd: CWD, profile: 'gw', turnsDir: dir, resolveEnv: async () => ({}), engineOpts: { enabled: () => true, ...standInOpts(s) }, idleMs: 60_000, stopGraceMs: 3000, ...o });
  await c.loading;
  return c;
}
const turnEnds = (c) => c.events.filter((e) => e.kind === 'turn-end');

test('the mapper: what the real server sent becomes the chat\'s events', async () => {
  const { OpencodeEvents } = await import('../../src/chat/engines/opencode-events.mjs');
  const map = new OpencodeEvents({ id: SESSION_ID, contextWindow: () => 200000 });
  const out = RECORDED.filter((x) => x.dir === '<').flatMap((x) => map.feed(x.m));
  const kinds = (k) => out.filter((e) => e.kind === k);
  // Text streams, then comes whole.
  assert.ok(kinds('text-delta').length >= 4);
  assert.deepEqual(kinds('text').map((e) => e.text).slice(0, 2), ['Understood, happy to help.', 'DONE']);
  assert.equal(kinds('thinking').length, 1);
  // The tools in the page's words: a new file and an edit are edits, the command is a shell command.
  assert.deepEqual(kinds('tool').map((e) => [e.name, e.toolKind]), [['Write', 'edit'], ['Edit', 'edit'], ['Bash', 'shell'], ['Bash', 'shell']]);
  assert.deepEqual(kinds('tool')[1].input, { file_path: '/work/proj/oc-notes.txt', old_string: 'alpha', new_string: 'beta' });
  const results = kinds('tool-result');
  assert.deepEqual(results[0].diff[0].lines, ['+alpha'], 'the new file\'s diff comes from its OK (its result has none)');
  assert.deepEqual(results[1].diff[0], { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha', '+beta'] });
  assert.equal(results[2].ok, false);
  assert.deepEqual([results[2].denied, results[2].text], [true, 'not now'], 'refused: "you said no", with his reason only');
  assert.deepEqual([results[3].stopped, results[3].text], [true, ''], 'stopped: no words of OpenCode\'s own files and shell ids');
  // An OK carries the whole of what the call does: the command as the call gave it, not OpenCode's pieces of it.
  const asks = kinds('ask');
  assert.equal(asks.length, 4);
  assert.deepEqual(asks.map((a) => a.tool), ['Write', 'Edit', 'Bash', 'Bash']);
  assert.equal(asks[3].subject, 'sleep 40 && echo late');
  assert.deepEqual(asks[3].full, { command: 'sleep 40 && echo late' });
  assert.equal(asks[0].subject, '/work/proj/oc-notes.txt');
  assert.ok(asks.every((a) => a.owner === null && !a.subjectCut));
  // "Allow in this chat": OpenCode's own patterns, kept by the chat; an edit's covers every edit.
  assert.deepEqual(asks[3].grant.atoms, ['opencode:shell:sleep *', 'opencode:shell:echo *']);
  assert.equal(asks[0].grant.edits, true);
  assert.deepEqual(asks[1].diff[0].lines, ['-alpha', '+beta'], 'the card shows the change it asks for');
  // Each turn ends; Stop's end says so; the title OpenCode gave.
  assert.deepEqual(kinds('turn-end').map((e) => [e.ok, e.error]), [[true, null], [true, null], [true, null], [true, null], [false, 'stopped']]);
  assert.ok(kinds('turn-end')[0].usage.input_tokens > 0);
  assert.deepEqual(kinds('title').map((e) => e.text), ['Exactly three short words', 'Recorded session']);
  assert.ok(kinds('usage').some((e) => e.contextWindow === 200000 && e.contextUsed > 0));
});

test('an OK whose call was not seen whole is the owner\'s; a subagent\'s events nest under its call; a question is a form', async () => {
  const { OpencodeEvents } = await import('../../src/chat/engines/opencode-events.mjs');
  const map = new OpencodeEvents({ id: 'ses_parent0001' });
  const ask = map.feed({ type: 'permission.asked', data: { id: 'per_x1', sessionID: 'ses_parent0001', action: 'shell', resources: ['rm -rf build'], save: ['rm *'], source: { type: 'tool', id: 'toolu_unseen' } } })[0];
  assert.equal(ask.owner, 'unknown');
  assert.equal(ask.subject, 'rm -rf build');
  assert.equal(ask.grant, null, 'nothing to allow for the rest of the chat when the call is not known');
  // A subagent: the call, then its own conversation, whose events nest under the call.
  map.feed({ type: 'session.tool.called', data: { sessionID: 'ses_parent0001', id: 'call_a', name: 'subagent', input: { description: 'Look around', prompt: 'List the files', agent: 'explore' } } });
  const task = map.feed({ type: 'session.created', data: { sessionID: 'ses_child00001', parentID: 'ses_parent0001', agent: 'explore', model: { id: 'claude-haiku-5-5' } } });
  assert.deepEqual(task.map((e) => [e.kind, e.taskId, e.toolId, e.status, e.title]), [['task', 'ses_child00001', 'call_a', 'running', 'Look around']]);
  const inner = map.feed({ type: 'session.text.ended', data: { sessionID: 'ses_child00001', assistantMessageID: 'msg_c', ordinal: 0, text: 'found 3 files' } });
  assert.equal(inner[0].agent, 'call_a');
  assert.deepEqual(map.feed({ type: 'session.text.ended', data: { sessionID: 'ses_other00001', assistantMessageID: 'm', ordinal: 0, text: 'not ours' } }), [], 'another conversation is not this chat\'s');
  assert.equal(task[0].background, true, 'a subagent runs in the background: the chat works until it ends');
  // Its call returns at once (it only started it): the task runs on until the subagent's own turn ends.
  const started = map.feed({ type: 'session.tool.success', data: { sessionID: 'ses_parent0001', id: 'call_a', content: [{ type: 'text', text: 'The subagent is working in the background' }] } });
  assert.deepEqual(started.filter((e) => e.kind === 'task'), []);
  const done = map.feed({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child00001' } });
  assert.deepEqual(done.map((e) => [e.kind, e.taskId, e.status]), [['task', 'ses_child00001', 'completed']]);
  assert.deepEqual(map.feed({ type: 'session.execution.started', data: { sessionID: 'ses_child00001' } }), [], 'not a turn of the chat');
  // A question to the owner: the chat's question card, the answers back in OpenCode's form.
  const q = map.feed({ type: 'form.created', data: { form: { id: 'frm_q1', sessionID: 'ses_parent0001', title: 'Which one?', fields: [
    { key: 'pick', type: 'string', title: 'Which database?', options: [{ value: 'pg', label: 'PostgreSQL' }, { value: 'my', label: 'MySQL' }] },
    { key: 'sure', type: 'boolean', title: 'Sure?' },
    { key: 'langs', type: 'multiselect', title: 'Languages?', options: [{ value: 'js', label: 'JavaScript' }, { value: 'go', label: 'Go' }] },
  ] } } })[0];
  assert.equal(q.type, 'question');
  assert.equal(q.owner, 'question');
  assert.deepEqual(q.input.questions.map((x) => [x.question, x.options.map((o) => o.label), x.multiSelect]), [['Which database?', ['PostgreSQL', 'MySQL'], false], ['Sure?', ['Yes', 'No'], false], ['Languages?', ['JavaScript', 'Go'], true]]);
  assert.deepEqual(map.formAnswer('frm_q1', { 'Which database?': 'PostgreSQL', 'Sure?': 'Yes', 'Languages?': 'JavaScript, Go' }), { pick: 'pg', sure: true, langs: ['js', 'go'] });
});

test('a chat on OpenCode: streamed answer, edits with diffs, OKs, Stop, a queued message, read back after closing', { timeout: 30_000 }, async (t) => {
  const s = await standIn();
  t.after(() => s.close());
  const c = await chatOn(s);
  // 1. A streamed answer; the chat takes the conversation's id from OpenCode.
  await c.send('Reply with exactly three short words, nothing else.');
  await until(() => turnEnds(c).length === 1, 'the first answer');
  assert.equal(c.conversationId, SESSION_ID);
  assert.equal(c.record().engine, 'opencode');
  assert.equal(c.lastText, 'Understood, happy to help.');
  const made = s.calls.find((x) => x.method === 'POST' && x.path === '/api/session');
  assert.deepEqual(made.body.permissions.map((r) => [r.action, r.effect]), [['edit', 'ask'], ['shell', 'ask'], ['webfetch', 'ask'], ['external_directory', 'ask']], 'no mode chosen: it asks first');
  assert.deepEqual(made.body.model, { providerID: 'hoprig_demo_000001', id: 'sample-model' });

  // 2. A new file: the OK, allowed once; the result with its diff.
  await c.send('Create a file');
  const a1 = await until(() => [...c.pending.values()][0], 'the OK for the new file');
  assert.equal(c.status(), 'attention');
  assert.equal(a1.tool, 'Write');
  c.answer(a1.request, { allow: true });
  await until(() => turnEnds(c).length === 2, 'the second turn');
  assert.equal(s.calls.find((x) => /\/permission\/per_.*\/reply$/.test(x.path)).body.decision, 'once');
  assert.deepEqual(c.events.find((e) => e.kind === 'tool-result' && e.diff).diff[0].lines, ['+alpha']);

  // 3. An edit, allowed in this chat: remembered by the chat (OpenCode is told "once": nothing is saved there).
  await c.send('Change the line');
  const a2 = await until(() => [...c.pending.values()][0], 'the OK for the edit');
  c.answer(a2.request, { allow: true, always: true });
  await until(() => turnEnds(c).length === 3, 'the third turn');
  assert.ok(c.grants.has('opencode:edit:*'));
  assert.ok(s.calls.filter((x) => /\/reply$/.test(x.path)).every((x) => x.body.decision !== 'always'));

  // 4. A command, refused with a reason.
  await c.send('Run ls');
  const a3 = await until(() => [...c.pending.values()][0], 'the OK for ls');
  assert.equal(a3.subject, 'ls -la /etc/hostname');
  c.answer(a3.request, { allow: false, message: 'not now' });
  await until(() => turnEnds(c).length === 4, 'the fourth turn');
  const no = s.calls.filter((x) => /\/reply$/.test(x.path)).at(-1).body;
  assert.equal(no.decision, 'reject');
  assert.match(no.message, /The user said no to this Bash call in the dashboard: not now\./);

  // 5. A long command, allowed; a second message queued meanwhile and taken back; then Stop.
  await c.send('Run sleep');
  const a4 = await until(() => [...c.pending.values()][0], 'the OK for sleep');
  c.answer(a4.request, { allow: true });
  await until(() => c.events.some((e) => e.kind === 'tool' && e.input && e.input.command === 'sleep 40 && echo late'), 'the long command');
  const q = await c.send('then say hello');
  assert.equal(q.queued, true);
  await until(() => c.queue.items[0] && c.session.inbox.has(q.id), 'the queued message at OpenCode');
  const back = await c.takeBack();
  assert.deepEqual(back.map((x) => x.text), ['then say hello']);
  assert.ok(s.calls.some((x) => x.method === 'DELETE' && /\/inbox\/msg_/.test(x.path)), 'taken back at OpenCode too');
  assert.equal(c.interrupt(), true);
  await until(() => turnEnds(c).length === 5, 'the stopped turn');
  assert.equal(turnEnds(c)[4].stopped, true);
  assert.equal(c.lastEnd, 'stopped');
  assert.ok(s.calls.some((x) => x.path.endsWith('/interrupt')));

  // Settings change in the running conversation: the mode's rules, the model's variant (ultracode: the highest).
  assert.deepEqual(await c.setSettings({ mode: 'bypassPermissions' }), { restart: false });
  assert.deepEqual(s.calls.filter((x) => x.method === 'PATCH').at(-1).body, { permissions: [] });
  assert.equal(c.bypass, true);
  await c.setSettings({ ultracode: true });
  assert.equal(s.calls.filter((x) => x.path.endsWith('/model')).at(-1).body.model.variant, 'max');
  await c.setSettings({ ultracode: false, effort: 'low' });
  assert.equal(s.calls.filter((x) => x.path.endsWith('/model')).at(-1).body.model.variant, 'low');
  await c.rename('My chat');
  assert.deepEqual(s.calls.filter((x) => x.method === 'PATCH').at(-1).body, { title: 'My chat' });
  // Nothing that returned the provider's key was asked for by anything but the engine itself.
  assert.ok(!JSON.stringify(c.events).includes(s.key));
  await c.close();
  assert.ok(!c.session);

  // The same conversation, after the chat closed: read back from OpenCode's store.
  const again = await chatOn(s, { conversationId: SESSION_ID });
  const users = again.events.filter((e) => e.kind === 'user').map((e) => e.text);
  assert.equal(users.length, MESSAGES.data.filter((m) => m.type === 'user').length);
  assert.equal(users[0], 'Reply with exactly three short words, nothing else.');
  assert.deepEqual(again.events.find((e) => e.kind === 'tool' && e.name === 'Edit').input, { file_path: '/work/proj/oc-notes.txt', old_string: 'alpha', new_string: 'beta' });
  assert.deepEqual(again.events.find((e) => e.kind === 'tool-result' && e.diff).diff[0].lines, ['-alpha', '+beta']);
  assert.equal(again.title, 'My chat', 'the name it has at OpenCode');
  // Read back as it was drawn live: the stopped command is the owner's act, not a failure with OpenCode's file path.
  const sleepId = again.events.find((e) => e.kind === 'tool' && /sleep 40/.test(e.input.command || '')).id;
  const stopped = again.events.find((e) => e.kind === 'tool-result' && e.id === sleepId);
  assert.deepEqual([stopped.stopped, stopped.text], [true, '']);
  assert.ok(!JSON.stringify(again.events).includes('output file'));
  assert.ok(again.events.filter((e) => e.kind === 'thinking').every((e) => e.text.trim()), 'no empty "Thought" lines');
  await again.close();
});

test('bypass: an OK is allowed by the chat, unless OpenCode did not say the whole call', { timeout: 20_000 }, async (t) => {
  const write = recordedTurns()[1];
  const blind = { ...write, steps: write.steps.filter((x) => !(x.event && x.event.type === 'session.tool.called')) };
  const s = await standIn({ turns: [write, blind] });
  t.after(() => s.close());
  const c = await chatOn(s, { permissionMode: 'bypassPermissions' });
  await c.send('Create a file');
  await until(() => turnEnds(c).length === 1, 'the turn');
  assert.equal(c.events.filter((e) => e.kind === 'ask').length, 0, 'no card in bypass');
  assert.equal(s.calls.find((x) => /\/reply$/.test(x.path)).body.decision, 'once');
  assert.deepEqual(s.calls.find((x) => x.method === 'POST' && x.path === '/api/session').body.permissions, [], 'bypass adds no rule');
  await c.send('Create it again');
  const a = await until(() => [...c.pending.values()][0], 'the card of a call not seen whole');
  assert.equal(a.owner, 'unknown');
  c.answer(a.request, { allow: true });
  await until(() => turnEnds(c).length === 2, 'the second turn');
  await c.close();
});

test('a provider that does not serve OpenCode never starts it; the server going away ends the turn plainly', { timeout: 20_000 }, async (t) => {
  const s = await standIn();
  t.after(() => s.close());
  const refuse = () => {
    throw Object.assign(new Error('The provider "Main" cannot be used for OpenCode: a Claude subscription is for Claude Code only.'), { status: 400 });
  };
  const c = await chatOn(s, { engineOpts: { enabled: () => true, ...standInOpts(s), providerFor: refuse } });
  await c.send('hello');
  await until(() => turnEnds(c).length === 1, 'the refusal');
  assert.match(turnEnds(c)[0].error, /OpenCode stopped \(provider\): .*a Claude subscription is for Claude Code only/);
  assert.ok(!s.calls.some((x) => x.path === '/api/session'), 'no conversation was made');
  await c.close();

  const d = await chatOn(s, { id: '1d9c2a4e-1b3f-4c5d-8e6f-0a1b2c3d4e5f' });
  await d.send('Reply with exactly three short words, nothing else.');
  await until(() => turnEnds(d).length === 1, 'an answer');
  s.drop();
  await until(() => !d.session, 'the chat sees the server go');
  await d.close();
});
