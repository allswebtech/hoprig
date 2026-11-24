// The contract's shape of what she reads and what is written down: every result is capped in code at 20,000
// characters with its fences whole, and every audit line names the door the call came through.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { RESULT_MAX, capParts, render } from '../../src/assistant/core.mjs';

test('a result is cut to 20,000 characters, the summary whole and every fence closed', () => {
  const big = { sessions: Array.from({ length: 3000 }, (_, i) => ({ name: `alpha-${i}`, note: 'x'.repeat(40) })) };
  const out = render({ summary: '3000 session(s).', data: big, terminal: { session: 'alpha', text: 'line\n'.repeat(20_000) } }, 'list_sessions');
  assert.ok(out.length <= RESULT_MAX, String(out.length));
  assert.ok(out.startsWith('3000 session(s).'));
  for (const kind of ['data', 'terminal_output']) {
    assert.equal(out.split(`<untrusted_${kind}`).length - 1, 1, kind);
    assert.equal(out.split(`</untrusted_${kind}>`).length - 1, 1, kind);
  }
  assert.match(out, /more characters cut: ask for less/);
  // A small result is left as it is.
  assert.deepEqual(capParts(['a', '<untrusted_data>{}</untrusted_data>']), ['a', '<untrusted_data>{}</untrusted_data>']);
});

test('every audit line names its door; an unknown door is written as the owner\'s one door', () => {
  const log = new AuditLog({ file: null, now: () => 1 });
  assert.equal(log.append({ actor: 'assistant', tool: 'start_session', level: 'L1', input: {}, outcome: 'done' }).door, 'team');
  assert.equal(log.append({ actor: 'assistant', tool: 'start_session', level: 'L1', input: {}, outcome: 'done', door: 'customer' }).door, 'team');
});

// The same start or message twice does it once; the acts that spend or send are capped per conversation and hour.
import { AuditLog as Log } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { CALLS_PER_HOUR, createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function core0(clock) {
  const ops = new FakeOps(baseState());
  const now = () => clock.t;
  const core = createAssistantCore({ ops, now, audit: new Log({ file: null, now }), cards: new CardStore({ now }), jobs: new JobStore({ dir: null, now }) });
  core.shown.add('c1', { session: ['this|web-ui'] });
  return { ops, call: (t, a, conv = 'c1') => core.call(t, a, { conversation: conv }) };
}

test('the same start twice within two minutes starts once; later, or in another conversation, again', async () => {
  const clock = { t: 1_800_000_000_000 };
  const { ops, call } = core0(clock);
  const starts = () => ops.calls.filter((c) => c.op === 'startChat').length;
  const a = { folder: '/home/owner/projects/api', account: 'sub', message: 'fix the failing test' };
  await call('start_chat', a);
  const again = await call('start_chat', a);
  assert.match(again.text, /done once, nothing was done again/);
  assert.equal(starts(), 1);
  await call('start_chat', a, 'c2');
  assert.equal(starts(), 2);
  clock.t += 3 * 60_000;
  await call('start_chat', a);
  assert.equal(starts(), 3);
  // The same text twice into a session is typed twice (a second "yes" to a second question is right).
  await call('send_to_session', { session: 'web-ui', text: 'yes' });
  await call('send_to_session', { session: 'web-ui', text: 'yes' });
  assert.equal(ops.calls.filter((c) => c.op === 'sendText').length, 2);
});

test('at most so many acts that spend or send per conversation and hour; reads are not counted', async () => {
  const clock = { t: 1_800_000_000_000 };
  const { ops, call } = core0(clock);
  for (let i = 0; i < CALLS_PER_HOUR; i++) assert.equal((await call('send_to_session', { session: 'web-ui', text: `step ${i}` })).isError, false);
  const over = await call('send_to_session', { session: 'web-ui', text: 'one more' });
  assert.equal(over.isError, true);
  assert.match(over.text, /the most she may.*Next:/);
  assert.equal(ops.calls.filter((c) => c.op === 'sendText').length, CALLS_PER_HOUR);
  assert.equal((await call('list_sessions', {})).isError, false);
  clock.t += 3600_000 + 1;
  assert.equal((await call('send_to_session', { session: 'web-ui', text: 'next hour' })).isError, false);
});

// The contract's length of a tool's description (with the note of its card): 40 to 1024 characters.
test('every tool description the model gets is 40 to 1024 characters', async () => {
  const { MCP_TOOLS } = await import('../../src/assistant/tools.mjs');
  for (const t of MCP_TOOLS) assert.ok(t.description.length >= 40 && t.description.length <= 1024, `${t.name}: ${t.description.length} characters`);
});

// The lines call() adds after the cut (characters taken out of her input, the card line, a repeat's sentence) are
// inside the 20,000 characters too.
test('a whole result through the core, with every line added after the cut, stays within 20,000 characters', async () => {
  const { createAssistantCore } = await import('../../src/assistant/core.mjs');
  const { CardStore } = await import('../../src/assistant/cards.mjs');
  const { JobStore } = await import('../../src/assistant/jobs.mjs');
  const { FakeOps, baseState } = await import('./fake-dashboard.mjs');
  const s = baseState();
  for (let i = 0; i < 3000; i++) s.sessions.push({ ...s.sessions[0], name: `alpha-${i}`, title: 'x'.repeat(40), sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  const core = createAssistantCore({ ops: new FakeOps(s), cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }) });
  // A zero-width character in her input: the note that it was taken out is added after the cut.
  const r = await core.call('list_sessions', { computer: 'th​is' }, { conversation: 'page-1' });
  assert.ok(r.text.length <= RESULT_MAX, String(r.text.length));
  assert.match(r.text, /more characters cut/);
});
