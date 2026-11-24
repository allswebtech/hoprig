// The sessions source names the next provider of Auto mode's order by its label, as the Providers page does, so the
// usage-limit item says "Claude Max can go on with it now", not the provider's short name. Made-up providers in a
// temporary home.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-nextlabel');
test.after(() => box.cleanup());

const P = await import('../../src/profiles.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { defaultSources } = await import('../../src/operator/sources.mjs');

test('the next provider of the order comes with its label; one without a label has none', async () => {
  P.writeProfile('sub', { label: 'Work sign-in' });
  P.writeProfile('sub2', { label: 'Claude Max', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } });
  saveConfig({ projectsDir: box.home, autoSwitch: { enabled: false, order: ['sub', 'sub2'] } });
  const cards = [{ name: 'alpha', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'sub', label: 'Work sign-in' }, status: 'waiting', statusAt: Date.now(), canSwitch: true }];
  let profiles = [{ name: 'sub', label: 'Work sign-in' }, { name: 'sub2', label: 'Claude Max' }];
  const ctx = { state: async () => ({ sessions: cards, profiles }), config: () => ({ projectsDir: box.home, server: {} }) };
  const src = defaultSources(ctx, { port: () => null });
  let [s] = await src.sources.sessions();
  assert.equal(s.nextProvider, 'sub2');
  assert.equal(s.nextProviderLabel, 'Claude Max');
  assert.equal(s.providerLabel, 'Work sign-in');
  profiles = [{ name: 'sub' }, { name: 'sub2' }];
  [s] = await src.sources.sessions();
  assert.equal(s.nextProvider, 'sub2');
  assert.equal(s.nextProviderLabel, null, 'the item then uses the short name');
});

test('an ended session and each provider come with the label, so their items name it as the Providers page does', async () => {
  saveConfig({ projectsDir: box.home, autoSwitch: { enabled: false, order: [] } });
  const cards = [{ name: 'beta', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'sub', label: 'Work sign-in' }, status: 'working', statusAt: Date.now() }];
  let profiles = [{ name: 'sub', label: 'Work sign-in' }, { name: 'sub2' }];
  const ctx = { state: async () => ({ sessions: cards, profiles }), config: () => ({ projectsDir: box.home, server: {} }) };
  const src = defaultSources(ctx, { port: () => null });
  await src.sources.sessions();
  // Its coding tool ended: the terminal is a plain shell now.
  cards.splice(0, 1, { name: 'beta', kind: 'shell', cwd: box.home });
  const [ended] = await src.sources.sessions();
  assert.deepEqual([ended.name, ended.state, ended.provider, ended.providerLabel], ['beta', 'ended', 'sub', 'Work sign-in']);
  const provs = await src.sources.providers();
  assert.deepEqual(provs.map((p) => [p.name, p.label]), [['sub', 'Work sign-in'], ['sub2', null]]);
  profiles = [{ name: 'sub' }];
  assert.equal((await src.sources.providers())[0].label, null, 'no label: the item uses the short name');
});
