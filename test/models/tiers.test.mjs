// "Lead model": the tiers picked from a provider's own list (src/models/tiers.mjs), a tier that falls to the next,
// the line said before the start, and the helpers Claude Code is given (its agent definitions: model and effort).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('tiers');
test.after(() => box.cleanup());
const { KINDS, TIERS, agentsFor, costLine, leadWords, pickTiers, tierOf } = await import('../../src/models/tiers.mjs');
const { modelsFor } = await import('../../src/models/catalog.mjs');

test('the table of kinds is data: three kinds, one per tier, the fast one at low effort, the hard one at high', () => {
  assert.deepEqual(TIERS, ['fast', 'strong', 'strongest']);
  assert.deepEqual(KINDS.kinds.map((k) => [k.id, k.tier, k.effort]), [['runner', 'fast', 'low'], ['coder', 'strong', 'medium'], ['thinker', 'strongest', 'high']]);
  assert.ok(!KINDS.kinds.some((k) => k.effort === 'max'), 'the highest effort is no kind\'s default');
});

test('a subscription: haiku runs, sonnet codes, opus thinks', async () => {
  const t = pickTiers(await modelsFor({ name: 'team', kind: 'subscription', env: {} }));
  assert.deepEqual([t.fast, t.strong, t.strongest, t.fell], ['haiku', 'sonnet', 'opus', []]);
  assert.equal(costLine(t), 'Fast, running and recording: haiku\nStrong, writing and reviewing code: sonnet\nStrongest, hard thinking: opus');
});

test('a gateway: the tiers from its own ids and labels, else from the profile\'s model variables', () => {
  const view = { models: [{ id: 'relay-main-2', label: 'Relay Main 2' }, { id: 'claude-haiku-5-5', label: 'x' }, { id: 'claude-opus-5-5', label: 'y' }] };
  const t = pickTiers(view, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-main-2' } });
  assert.deepEqual([t.fast, t.strong, t.strongest], ['claude-haiku-5-5', 'relay-main-2', 'claude-opus-5-5']);
  assert.equal(tierOf({ id: 'relay-1', label: 'Relay Sonnet' }), 'strong', 'a label names the family too');
  assert.equal(tierOf({ id: 'haikuish-1' }), null, 'a word only inside another is no family');
});

test('a tier the provider lacks falls to the next it has, and the line says so before the start', () => {
  const t = pickTiers({ models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet' }] });
  assert.deepEqual([t.fast, t.strong, t.strongest], ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(t.fell, [{ tier: 'fast', to: 'strong' }, { tier: 'strongest', to: 'strong' }]);
  assert.equal(costLine(t), 'This provider has one model: every part runs on claude-sonnet-5-5, so Lead saves nothing here.', 'one model: one sentence, not the same id three times');
  assert.equal(costLine(pickTiers({ models: [{ id: 'relay-sonnet-2' }, { id: 'relay-opus-3' }] })), 'Fast, running and recording: relay-sonnet-2 (it has no fast model)\nStrong, writing and reviewing code: relay-sonnet-2\nStrongest, hard thinking: relay-opus-3', 'one short line per tier');
  const none = pickTiers({ models: [{ id: 'relay-1', label: 'relay-1' }] });
  assert.equal(none.missing, true);
  assert.match(costLine(none), /names no Haiku, Sonnet or Opus model, so Lead model will not split the work on this provider/);
  assert.deepEqual(agentsFor(none), {}, 'no helper without a tier');
});

test('the helpers: one agent definition per kind with its model and effort, no key and no address in them', () => {
  const t = pickTiers({ models: [{ id: 'haiku', label: '' }, { id: 'sonnet', label: '' }, { id: 'opus', label: '' }] });
  const a = agentsFor(t);
  assert.deepEqual(Object.keys(a), ['hoprig-runner', 'hoprig-coder', 'hoprig-thinker']);
  assert.deepEqual(Object.values(a).map((x) => [x.model, x.effort]), [['haiku', 'low'], ['sonnet', 'medium'], ['opus', 'high']]);
  for (const x of Object.values(a)) assert.deepEqual(Object.keys(x).sort(), ['description', 'effort', 'model', 'prompt']);
  assert.ok(!/key|token|http|password/i.test(JSON.stringify(a)), 'nothing secret or an address');
  assert.match(leadWords(t), /hoprig-runner/);
  assert.match(leadWords(t), /highest effort is for a part whose brief says why/);
  assert.match(leadWords(t), /Never pass a model or an effort when you call a helper/, 'a model passed with the call would win over the helper\'s own');
});

test('the id names the family; a label only for an id that names none, and only when it names one family', () => {
  assert.equal(tierOf({ id: 'claude-opus-5-5', label: 'Opus 5.5, smarter than Sonnet' }), 'strongest');
  assert.equal(tierOf({ id: 'claude-opus-5-5', label: 'Haiku' }), 'strongest', 'a label never moves a model the id names');
  assert.equal(tierOf({ id: 'relay-x', label: 'Faster than Haiku, smarter than Opus' }), null, 'two families: none');
  assert.equal(tierOf({ id: 'relay-x', label: 'Relay Haiku' }), 'fast');
  const t = pickTiers({ models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5, smarter than Sonnet' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }] });
  assert.deepEqual([t.fast, t.strong, t.strongest], ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  const liar = pickTiers({ models: [{ id: 'relay-x', label: 'Faster than Haiku, smarter than Opus' }, { id: 'claude-opus-5-5', label: 'Haiku' }, { id: 'claude-sonnet-5-5', label: 'x' }] });
  assert.deepEqual([liar.fast, liar.strong, liar.strongest], ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('Opus wins the strongest tier over Fable, with bare names and with exact ids; Fable only where no Opus is listed', () => {
  assert.equal(pickTiers({ models: [{ id: 'fable' }, { id: 'opus' }, { id: 'sonnet' }] }).strongest, 'opus');
  assert.equal(pickTiers({ models: [{ id: 'claude-fable-5' }, { id: 'claude-opus-5-5' }] }).strongest, 'claude-opus-5-5');
  // As the API lists them, newest first.
  const t = pickTiers({ models: ['claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({ id })) });
  assert.equal(agentsFor(t)['hoprig-thinker'].model, 'claude-opus-5-5');
  assert.equal(pickTiers({ models: [{ id: 'claude-fable-5' }, { id: 'claude-sonnet-5-5' }] }).strongest, 'claude-fable-5');
});

test('never the list\'s order: the profile\'s own variables, then the family name, then the newest id of the family', () => {
  // Alphabetical, as some gateways list them: the oldest ids come first.
  const ids = ['claude-3-5-haiku-20241022', 'claude-3-7-sonnet-20250219', 'claude-3-opus-20240229', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5',
    'claude-opus-4-1-20250805', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'zeta-1'];
  const view = { models: ids.map((id) => ({ id })) };
  const t = pickTiers(view);
  assert.deepEqual([t.fast, t.strong, t.strongest], ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  // The same list in another order picks the same.
  const back = pickTiers({ models: [...view.models].reverse() });
  assert.deepEqual([back.fast, back.strong, back.strongest], [t.fast, t.strong, t.strongest]);
  // The profile's own choice wins where the list holds it; one the list leaves out does not.
  const own = pickTiers(view, { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-9' } });
  assert.deepEqual([own.fast, own.strong, own.strongest], ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  // The family name before an exact id.
  assert.equal(pickTiers({ models: [{ id: 'claude-sonnet-5-5' }, { id: 'sonnet' }] }).strong, 'sonnet');
  // A long list with a vendor prefix and dates: the highest version, not the first entry.
  const many = { models: Array.from({ length: 200 }, (_, i) => ({ id: `vendor/claude-${['haiku', 'sonnet', 'opus', 'fable'][i % 4]}-${Math.floor(i / 4) % 10}-202${i % 7}0101` })) };
  const m = pickTiers(many);
  assert.match(m.fast, /^vendor\/claude-haiku-9-/);
  assert.match(m.strongest, /^vendor\/claude-opus-9-/);
});

test('a helper\'s effort keeps to the efforts the provider lists for its model, and the line says what moved', () => {
  const view = { models: [{ id: 'gw-haiku-1' }, { id: 'gw-sonnet-1', efforts: ['low', 'high'] }, { id: 'gw-opus-1', efforts: ['low'] }] };
  const t = pickTiers(view);
  const a = agentsFor(t);
  assert.deepEqual(Object.values(a).map((x) => [x.model, x.effort]), [['gw-haiku-1', 'low'], ['gw-sonnet-1', 'low'], ['gw-opus-1', 'low']]);
  assert.match(costLine(t), /The provider lists no medium effort for gw-sonnet-1, so writing and reviewing code runs at low; no high effort for gw-opus-1, so hard thinking runs at low\./);
  // Efforts Claude Code does not take: none is given, and the line says the default is used.
  const odd = pickTiers({ models: [{ id: 'gw-opus-1', efforts: ['turbo'] }] });
  assert.equal(agentsFor(odd)['hoprig-thinker'].effort, undefined);
  assert.match(costLine(odd), /runs at its default effort/);
  // Listed efforts that hold the kind's own: unchanged, nothing said.
  const ok = pickTiers({ models: [{ id: 'gw-opus-1', efforts: ['low', 'medium', 'high'] }] }); // every kind falls to it
  assert.equal(agentsFor(ok)['hoprig-thinker'].effort, 'high');
  assert.ok(!/lists no/.test(costLine(ok)));
  assert.ok(!/effort/.test(costLine(pickTiers({ models: [{ id: 'gw-opus-1' }] }))), 'no efforts listed: nothing said');
});
