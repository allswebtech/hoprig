// Restore starts its terminals through the Deck like every other start: the launcher's words go into a launch file
// (src/launchfile.mjs), and the typed line holds only the launcher's own command and that file. A conversation that
// still runs is found before anything is made: the first try and the second one (restore.mjs RETRY_MS) leave no
// launch file behind when they give up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('restore-launch');
test.after(() => box.cleanup());

const SID = '33333333-3333-4333-8333-333333333333';

test('restore: a start writes a launch file; a conversation that still runs leaves none, also after the second try', async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { Deck } = await import('../../src/server/deck.mjs');
  const { launchDir } = await import('../../src/launchfile.mjs');
  const { serverAdapter } = await import('../../src/automation/feature.mjs');
  const restore = await import('../../src/automation/restore.mjs');
  writeProfile('api', { label: 'API', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const created = [];
  const backend = {
    platform: process.platform,
    list: async () => [],
    create: async (o) => (created.push(o), { name: o.name, id: `%${created.length}` }),
  };
  const deck = new Deck({ backend, config: () => ({ launcher: [process.execPath, '/opt/hoprig/bin/hoprig.mjs'] }), profiles: () => [] });
  // The chat feature's claim: a conversation that a chat (or a terminal) runs is never started a second time.
  let busy = true;
  const chat = { startTerminal: async (id, go) => (busy ? { existing: { chat: 'c1' } } : { name: await go() }) };
  const ctx = serverAdapter({ deck, state: async () => ({ sessions: [] }) }, { chat, log: () => {} });
  const files = () => (fs.existsSync(launchDir()) ? fs.readdirSync(launchDir()) : []);
  const action = { type: 'reopen', session: { name: 'work', cwd: box.root, profile: 'api', sessionId: SID, carryArgs: ['--model', 'opus'] } };

  const entries = [];
  let again = null;
  await restore.apply([action], { deck: ctx.deck, record: (e) => entries.push(e), conversationExists: () => true, later: (fn) => (again = fn) });
  assert.deepEqual([created.length, files()], [0, []], 'the first try made nothing');
  await again();
  assert.deepEqual([created.length, files()], [0, []], 'the second try gave up and made nothing either');
  assert.equal(entries.length, 1);
  assert.match(entries[0].outcome, /^skipped: a chat runs its conversation now/);

  busy = false;
  await restore.apply([action], { deck: ctx.deck, record: (e) => entries.push(e), conversationExists: () => true, later: () => assert.fail('no second try') });
  assert.equal(created.length, 1);
  const argv = created[0].argv;
  const at = argv.indexOf('--launch');
  assert.ok(at > 0, 'the typed line names a launch file');
  assert.deepEqual(argv.slice(0, at), [process.execPath, '/opt/hoprig/bin/hoprig.mjs'], 'and nothing else than the launcher');
  assert.deepEqual(files(), [argv[at + 1].split('/').pop()], 'one launch file, for the launcher to take');
  const held = JSON.parse(fs.readFileSync(argv[at + 1], 'utf8'));
  assert.equal(held.cwd, box.root);
  assert.ok(held.argv.includes(SID) && held.argv.includes('--model') && held.argv.includes('opus'), JSON.stringify(held.argv));
  assert.equal(entries.at(-1).outcome, 'ok');
});

test('restore: the launch file carries a reset hand (Hands-off offered), so the reopened run starts off', async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { Deck } = await import('../../src/server/deck.mjs');
  const { serverAdapter } = await import('../../src/automation/feature.mjs');
  const restore = await import('../../src/automation/restore.mjs');
  writeProfile('api', { label: 'API', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const created = [];
  const backend = { platform: process.platform, list: async () => [], create: async (o) => (created.push(o), { name: o.name, id: `%${created.length}` }) };
  const deck = new Deck({ backend, config: () => ({ launcher: [process.execPath, '/opt/hoprig/bin/hoprig.mjs'], handsOff: { offered: true } }), profiles: () => [] });
  const chat = { startTerminal: async (id, go) => ({ name: await go() }) }; // nothing runs it: the start proceeds
  const ctx = serverAdapter({ deck, state: async () => ({ sessions: [] }), config: () => ({ handsOff: { offered: true } }) }, { chat, log: () => {} });
  const action = { type: 'reopen', session: { name: 'work', cwd: box.root, profile: 'api', sessionId: SID, carryArgs: [] } };
  await restore.apply([action], { deck: ctx.deck, record: () => {}, conversationExists: () => true, later: () => {} });
  assert.equal(created.length, 1, 'the reopen started');
  const argv = created[0].argv;
  const held = JSON.parse(fs.readFileSync(argv[argv.indexOf('--launch') + 1], 'utf8'));
  assert.deepEqual(held.hand, { reset: true }, 'a restore after a reboot hands a reset: the reopened run is the owner\'s until he turns it on');
});
