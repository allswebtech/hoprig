// Tia's engine (and the coding chat, which takes providerEnv as it is) under an Auto mode whose order holds providers,
// none of which Auto mode may use: a key billed by use while "Also use pay-per-use providers" is off, a provider that
// does not exist any more, an OpenAI key that does not serve Claude Code. The engine says why in the router's words,
// never "no order of providers yet", and a decision's call (pickProvider) goes on to the subscription she may use.
// Made-up providers in a temporary home; no router is started (Auto mode has no identity to run as).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('engine-auto-nothing');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const P = await import('../../src/profiles.mjs');
const A = await import('../../src/autoswitch.mjs');
const { engineEnv, providerEnv } = await import('../../src/assistant/engine.mjs');
const { pickProvider } = await import('../../src/operator/decider.mjs');

P.writeProfile('plan', { label: 'Plan', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
P.writeProfile('key', { label: 'Shop key', env: { ANTHROPIC_API_KEY: 'demo-not-a-key' } });
P.writeProfile('oai', { label: 'Example OpenAI', env: { OPENAI_API_KEY: 'demo-not-a-key' } });
// The accounts as the dashboard lists them (/api/state): the providers' public fields and Auto mode's settings.
const accounts = () => ({ profiles: P.listProfiles().map(P.publicProfile), autoSwitch: A.getAutoSwitch() });
const cfg = (allowed) => ({ assistant: { enabled: true, level: 'work', accounts: allowed } });

test('a key billed by use alone in the order, pay-per-use off: the engine says why, and a call goes to the subscription', async () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['key'], payPerUse: false } });
  assert.deepEqual(A.usableOrder(), []);
  const said = 'Auto mode has nothing it may use, because Shop key in its order is billed by use and "Also use pay-per-use providers" is off: turn that switch on on the Providers page, or put a subscription into the order';
  await assert.rejects(providerEnv('auto'), { message: said });
  await assert.rejects(engineEnv('auto'), { message: said });
  assert.deepEqual(pickProvider(cfg(['auto', 'plan']), accounts()), { provider: 'plan' });
  assert.deepEqual(pickProvider(cfg(['auto']), accounts()), { error: 'Auto mode has nothing it may use, because Shop key in its order is billed by use and "Also use pay-per-use providers" is off' });
});

test('an order of a provider that is gone and one that does not serve Claude Code: each reason, never "no order yet"', async () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['ghost', 'oai'], payPerUse: true } });
  await assert.rejects(providerEnv('auto'), { message: 'Auto mode has nothing it may use, because ghost in its order does not exist any more, and Example OpenAI does not serve Claude Code: put a provider that serves Claude Code into the order on the Providers page, or run: hoprig auto order <provider> <provider>' });
  assert.deepEqual(pickProvider(cfg(['auto', 'plan']), accounts()), { provider: 'plan' });
  // An empty order: the sentence of before.
  saveConfig({ autoSwitch: { enabled: true, order: [] } });
  await assert.rejects(providerEnv('auto'), { message: 'Auto mode has no order of providers yet' });
});
