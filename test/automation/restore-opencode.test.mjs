// Reopen after a restart brings back OpenCode's terminal sessions on their own conversation id, the way it brings
// back Claude Code's. A session whose run record holds no id that OpenCode's store would know (none yet, or a
// malformed one) is not reopened on "the folder's newest conversation": it is left out and named in the activity log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as restore from '../../src/automation/restore.mjs';
import { sandbox } from '../server/helpers.mjs';
import { claude } from './helpers.mjs';

const box = sandbox('restore-opencode');
test.after(() => box.cleanup());

const OC = 'ses_AbCdEf1234567890';
const CC = '33333333-3333-4333-8333-333333333333';
const oc = (name, sessionId) => claude(name, { kind: 'claude', tool: 'opencode', sessionId, cwd: '/w/shop', profile: { name: 'api' }, carryArgs: ['--model', 'alpha/one'] });

test('an OpenCode terminal session is reopened on its id; one with no id or a bad id is named as skipped', async () => {
  const cards = [oc('oc-good', OC), oc('oc-none', null), oc('oc-bad', 'not-an-id'), claude('cc', { sessionId: CC })];
  let r = restore.decide({ cards, data: null, now: 1000, boot: false, enabled: true });
  r = restore.decide({ cards: [], data: r.data, now: 2000, boot: true, enabled: true });
  const started = [];
  const entries = [];
  await restore.apply(r.actions, {
    deck: { start: async (o) => (started.push(o), o.name) },
    conversationExists: () => true,
    record: (e) => entries.push(e),
    later: () => assert.fail('no second try'),
  });
  const by = Object.fromEntries(started.map((o) => [o.name, o]));
  assert.deepEqual(Object.keys(by).sort(), ['cc', 'oc-good'], 'only the sessions with a known conversation start');
  assert.equal(by['oc-good'].tool, 'opencode');
  assert.equal(by['oc-good'].sessionId, OC);
  assert.equal(by['oc-good'].mode, 'move');
  assert.deepEqual(by['oc-good'].carryArgs, ['--model', 'alpha/one']);
  assert.equal(by['oc-good'].fresh, undefined, 'an OpenCode conversation is resumed, never started fresh under its id');
  assert.equal(by.cc.tool ?? 'claude', 'claude', "Claude Code's reopen is unchanged");
  assert.equal(by.cc.sessionId, CC);
  const skipped = entries.filter((e) => /^skipped/.test(e.outcome)).map((e) => e.session).sort();
  assert.deepEqual(skipped, ['oc-bad', 'oc-none'], 'each one left out is named');
  for (const e of entries.filter((x) => /^skipped/.test(x.outcome))) assert.match(e.outcome, /no conversation id/);
});

test('a Codex terminal session is still not reopened', () => {
  const codex = claude('cx', { tool: 'codex', sessionId: '0199a9e2-1111-7222-8333-444444444444' });
  let r = restore.decide({ cards: [codex], data: null, now: 1000, boot: false, enabled: true });
  assert.deepEqual(r.data.sessions, {});
  r = restore.decide({ cards: [], data: r.data, now: 2000, boot: true, enabled: true });
  assert.deepEqual(r.actions, []);
});

test("the server's start of a reopen runs OpenCode on that conversation, through the one-process claim", async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { Deck } = await import('../../src/server/deck.mjs');
  const { serverAdapter } = await import('../../src/automation/feature.mjs');
  writeProfile('api', { label: 'API', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const created = [];
  const backend = { platform: process.platform, list: async () => [], create: async (o) => (created.push(o), { name: o.name, id: `%${created.length}` }) };
  const deck = new Deck({ backend, config: () => ({ launcher: [process.execPath, '/opt/hoprig/bin/hoprig.mjs'] }), profiles: () => [] });
  const claims = [];
  const chat = { startTerminal: async (id, go, tool) => (claims.push([id, tool]), { name: (await go()).name }) };
  const ctx = serverAdapter({ deck, state: async () => ({ sessions: [] }) }, { chat, log: () => {} });
  const action = { type: 'reopen', session: { name: 'oc', tool: 'opencode', cwd: box.root, profile: 'api', sessionId: OC, carryArgs: ['--model', 'alpha/one'] } };
  const entries = [];
  await restore.apply([action], { deck: ctx.deck, record: (e) => entries.push(e), conversationExists: () => false, later: () => {} });
  assert.deepEqual(claims, [[OC, 'opencode']], "the claim is asked for OpenCode's conversation");
  assert.equal(created.length, 1);
  const argv = created[0].argv;
  const held = JSON.parse(fs.readFileSync(argv[argv.indexOf('--launch') + 1], 'utf8'));
  const words = held.argv;
  assert.ok(words.includes('opencode'), JSON.stringify(words));
  assert.equal(words[words.indexOf('--resume') + 1], OC, JSON.stringify(words));
  assert.ok(words.includes('alpha/one'), JSON.stringify(words));
  assert.equal(entries.at(-1).outcome, 'ok');
  assert.match(entries.at(-1).did, /resumed ses_/);
});
