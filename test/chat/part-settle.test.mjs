// A part's chat whose process ends is settled from its own figure (src/chat/feature.mjs settleChat), also when that
// figure is below the base its budget hold was bound at: a new conversation in the chat starts again at nothing, and
// what it cost adds to what was measured before it (spend.mjs measure). No tick of Tia comes between: the chat's own
// end is the only measure. Claude Code is a stand-in (fixtures/fake-claude.mjs, a cent a turn): no provider is asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const box = sandbox('partsettle');
test.after(() => box.cleanup());
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { SpendLedger } = await import('../../src/assistant/spend.mjs');
const { chatFeature } = await import('../../src/chat/feature.mjs');

// Billed by use: a key straight to the vendor. Never asked: the chat is a stand-in.
writeProfile('paid', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });
const near = (a, b) => Math.abs(a - b) < 1e-6;
const until = async (what, ok) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(ok(), what);
};

test('a part\'s chat in a new conversation below its base, ended before a tick: what it cost counts, beside the earlier measure', async (t) => {
  const proj = path.join(box.root, 'proj', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: 3 }, automation: { schedules: { atOnce: 1 } } });
  const l = new SpendLedger({ file: null });
  const f = chatFeature({ HttpError: Error, config: () => loadConfig(), readJson: async () => ({}), backend: { list: async () => [] } }, {
    file: path.join(box.root, 'chats.json'), command: { command: process.execPath, args: [FAKE] }, idleMs: 400, spend: l,
    resolveEnv: async () => ({ ...process.env }),
  });
  t.after(() => f.close());
  const a = await f.open({ dir: proj, tool: 'claude', profile: 'paid', text: 'look over the shop', defaults: true }, { maxBudgetUsd: 1 });
  assert.equal(a.sent, true);
  // As the part door does: its $1 held and bound to the chat, here at a base of 1.0 (the chat's figure in the
  // conversation it had before), which a tick saw run to 1.5. The chat now runs a new conversation: it starts at 0.
  const key = `this|chat:${a.id}`;
  assert.equal(l.take(3, { id: 'part-x', amount: 1 }), null);
  l.bind('part-x', key, 1.0, true);
  l.measure(key, 0.5, false, 1.5);
  // Its turn (the stand-in reports $0.01), then its idle stop ends the process: the hold is settled.
  await until('its process ended and its hold was settled', () => l.memory.some((e) => e.kind === 'spent' && e.hold === 'part-x'));
  const d = l.detail();
  const measured = l.memory.filter((e) => e.kind === 'measured').map((e) => [e.usd, e.raw]);
  t.diagnostic(`detail=${JSON.stringify(d)} measured=${JSON.stringify(measured)}`);
  assert.ok(near(d.spent, 0.51), `the earlier 0.5 and the new conversation's 0.01: ${JSON.stringify(d)}`);
  assert.ok(near(measured.at(-1)[1], 0.01), `its own figure is the last one written: ${JSON.stringify(measured)}`);
  assert.equal(d.parts, undefined, 'no hold left running');
});
