// "Lead model" at a session's start (src/models/lead.mjs): off is exactly the start before the switch came; on, Claude
// Code gets its helpers (one agent definition per kind, with model and effort) and one instruction to the lead.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('lead');
test.after(() => box.cleanup());
const { chatArgs } = await import('../../src/chat/engines/claude-lines.mjs');
const { LEAD_ONLY_CLAUDE, leadArgs, leadPlan } = await import('../../src/models/lead.mjs');
const { forgetModels, modelsFor } = await import('../../src/models/catalog.mjs');

const sub = { name: 'team', kind: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } };
const relay = { name: 'relay', kind: 'api', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8242', ANTHROPIC_AUTH_TOKEN: 'sk-relay-lead-key-0123456789' } };

// The arguments of these starts as e622f62 made them (before Lead): the switch off must give exactly these.
const BEFORE = [
  [{ sessionId: 'S1' }, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions', '--session-id', 'S1']],
  [{ sessionId: 'S1', resume: true, permissionMode: 'manual', effort: 'high', model: 'opus', settings: '/x/s.json' }, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions', '--permission-mode', 'manual', '--settings', '/x/s.json', '--effort', 'high', '--model', 'opus', '--resume', 'S1']],
  [{ sessionId: 'S1', fork: { from: 'S0', at: 'U1' }, permissionMode: 'bypassPermissions', allowBypass: false }, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--resume', 'S0', '--fork-session', '--session-id', 'S1', '--resume-session-at', 'U1']],
];

test('Lead off: the start\'s arguments are exactly those before the switch came', () => {
  for (const [o, want] of BEFORE) {
    assert.deepEqual(chatArgs(o), want);
    assert.deepEqual(chatArgs({ ...o, lead: leadArgs(null) }), want);
    assert.deepEqual(chatArgs({ ...o, lead: leadArgs({ can: false, why: 'x' }) }), want);
  }
});

test('Lead on, a subscription: haiku runs, sonnet codes, opus thinks, given as Claude Code\'s own helpers', () => {
  const plan = leadPlan(sub);
  assert.equal(plan.can, true);
  const a = chatArgs({ sessionId: 'S1', model: 'sonnet', lead: leadArgs(plan) });
  const agents = JSON.parse(a[a.indexOf('--agents') + 1]);
  assert.deepEqual(Object.entries(agents).map(([n, x]) => [n, x.model, x.effort]), [['hoprig-runner', 'haiku', 'low'], ['hoprig-coder', 'sonnet', 'medium'], ['hoprig-thinker', 'opus', 'high']]);
  assert.match(a[a.indexOf('--append-system-prompt') + 1], /You lead this task/);
  assert.deepEqual(a.slice(-2), ['--session-id', 'S1'], 'the conversation still comes last');
  assert.equal(plan.line, 'Fast, running and recording: haiku\nStrong, writing and reviewing code: sonnet\nStrongest, hard thinking: opus');
});

test('Lead on a gateway: only its own models, never another provider\'s; nothing asked to decide', async () => {
  forgetModels();
  assert.equal(leadPlan(relay).can, false, 'no list known yet: the fallback\'s family names are not this gateway\'s models');
  assert.equal(leadPlan({ ...relay, env: { ...relay.env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay-small-1' } }).tiers.fast, 'relay-small-1', 'the profile\'s own variables still count');
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'relay-sonnet-2' }, { id: 'relay-opus-3' }] }));
  await modelsFor(relay, { fetchImpl });
  const plan = leadPlan(relay);
  assert.equal(plan.can, true);
  assert.deepEqual([plan.tiers.fast, plan.tiers.strong, plan.tiers.strongest], ['relay-sonnet-2', 'relay-sonnet-2', 'relay-opus-3']);
  assert.match(plan.line, /^Fast, running and recording: relay-sonnet-2 \(it has no fast model\)$/m);
  const all = JSON.stringify(leadArgs(plan));
  assert.ok(!all.includes('sk-relay') && !all.includes('127.0.0.1'), 'no key or address in what the model is given');
  assert.ok(!/haiku|"opus"|"sonnet"/.test(all), 'no model of another provider');
});

test('Lead with another coding tool: off, with one line why', () => {
  const plan = leadPlan(sub, { tool: 'opencode' });
  assert.deepEqual(plan, { can: false, why: LEAD_ONLY_CLAUDE });
  assert.deepEqual(leadArgs(plan), []);
});

test('a chat with Lead on starts Claude Code with its helpers; off, and an old record without the switch, without', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { Chat } = await import('../../src/chat/chat.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const FAKE = path.join(import.meta.dirname, '..', 'chat', 'fixtures', 'fake-claude.mjs');
  writeProfile('team', { label: 'Team', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  const startOf = async (rec, name) => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
    const argsFile = path.join(box.root, `${name}.args`);
    const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'team', ...rec, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }) });
    t.after(() => c.stopAndWait());
    const done = new Promise((r) => c.once('turn', r));
    await c.send('hello');
    await done;
    return { c, args: fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray)[0] };
  };
  const on = await startOf({ lead: true }, 'on');
  assert.ok(on.args.includes('--agents'));
  assert.equal(on.c.record().lead, true, 'saved with the chat');
  const off = await startOf({}, 'off');
  assert.ok(!off.args.includes('--agents') && !off.args.includes('--append-system-prompt'));
  assert.equal('lead' in off.c.record(), false, 'off writes nothing new into the record');
  // Turned on while it is idle: the next start has the helpers (they are given at the start only).
  const r = await off.c.setSettings({ lead: true });
  assert.equal(off.c.lead, true);
  assert.equal(typeof r.restart, 'boolean');
});
