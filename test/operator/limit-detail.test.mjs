// The limit rule's detail on the Operator page says what the code does with a provider paid per use: only at "Hands
// off" and inside Tia's daily spending cap, which counts the move. Its behaviour both ways is held in money.test.mjs;
// here the words the page shows, as the server sends them. A made-up world: nothing here moves anything.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-limit-detail');
test.after(() => box.cleanup());

const { RULES } = await import('../../src/operator/rules.mjs');
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');

test('the limit rule\'s detail: paid per use only at "Hands off" and inside the daily cap, which counts the move', () => {
  const limit = RULES.find((r) => r.id === 'limit');
  assert.match(limit.detail, /to a provider paid per use only at "Hands off" and inside her daily limit for paid use \(which counts the move\)/);
  assert.match(limit.detail, /never while Auto mode is on, and never back to a provider the session left within the hour\.$/, 'the rest stays');
  saveConfig({ assistant: { enabled: true }, operator: { acts: false, rules: {} } });
  const ctx = { HttpError: Error, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: () => () => {} };
  const f = operatorFeature(ctx, {
    sources: { sessions: () => [], gateways: () => [], live: () => null, leftovers: () => [], machine: () => null },
    cacheMs: 0,
    accounts: async () => ({ profiles: [] }),
    turn: async () => ({ ok: false }),
    session: { move: async () => {} },
    acts: {},
  });
  try {
    assert.equal(f.reflex.view().rules.find((r) => r.id === 'limit').detail, limit.detail, 'the page gets these words');
  } finally {
    f.close();
  }
});
