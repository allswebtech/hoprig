// "Use other providers" (src/models/others.mjs): which providers can be ticked, and the one gate a part passes. The
// ticks are the server's record; a provider not ticked, one Tia may not use, one at its limit, one billed by use
// without the owner's word, and a part past the computer's limit never start.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('others');
test.after(() => box.cleanup());
const { writeProfile } = await import('../../src/profiles.mjs');
const { markLimited } = await import('../../src/autoswitch.mjs');
const { cleanOthers, otherProviders, partGate, ticksOf } = await import('../../src/models/others.mjs');

// Stand-in addresses: nothing here asks them (the gate reads files only).
writeProfile('main', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8243', ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
writeProfile('beta', { label: 'Beta', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8244', ANTHROPIC_AUTH_TOKEN: 'sk-beta-test-0123456789' } });
writeProfile('gamma', { label: 'Gamma', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8245', ANTHROPIC_AUTH_TOKEN: 'sk-gamma-test-0123456789' } });
writeProfile('paid', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });

const lead = (others, o = {}) => ({ lead: true, others, profile: 'main', ...o });

test('the tick list: every other provider that serves Claude Code, with its tools, billing and limit; no key or address', () => {
  const list = otherProviders('main', ['alpha']);
  assert.deepEqual(list.map((p) => p.name).sort(), ['alpha', 'beta', 'gamma', 'paid']);
  assert.equal(list.find((p) => p.name === 'paid').paid, true);
  assert.equal(list.find((p) => p.name === 'alpha').ticked, true);
  assert.ok(list.find((p) => p.name === 'alpha').tools.includes('claude'), 'its coding tools, as Providers shows them');
  const all = JSON.stringify(list);
  for (const bit of ['sk-', '127.0.0.1', '8243']) assert.ok(!all.includes(bit), bit);
  assert.deepEqual(cleanOthers(['alpha', 'beta', 'alpha'], 'main'), ['alpha', 'beta']);
  assert.throws(() => cleanOthers(['main'], 'main'), /own provider/);
  assert.throws(() => cleanOthers(['nobody'], 'main'), /no provider "nobody"/);
  assert.throws(() => cleanOthers('alpha', 'main'), /list/);
  assert.deepEqual(ticksOf(undefined), [], 'an old record without ticks: none');
});

test('two ticked and one not: a part may go to a ticked one, never to the other', () => {
  const s = lead(['alpha', 'beta']);
  assert.deepEqual(partGate(s, 'alpha', { atOnce: 2 }), { ok: true });
  assert.deepEqual(partGate(s, 'beta', { atOnce: 2 }), { ok: true });
  assert.match(partGate(s, 'gamma', { atOnce: 2 }).refuse, /not one of the providers ticked/);
  assert.match(partGate({ ...s, lead: false }, 'alpha').refuse, /Lead model is off/);
  assert.match(partGate(lead([]), 'alpha').refuse, /"Use other providers" is off/);
});

test('billed by use: a card unless the owner allowed it; at its limit: skipped; past the computer\'s limit: not at once', () => {
  assert.match(partGate(lead(['paid']), 'paid').card, /billed by use/);
  assert.deepEqual(partGate(lead(['paid']), 'paid', { paidOk: true }), { ok: true });
  markLimited('beta', { until: Date.now() + 3_600_000 });
  assert.match(partGate(lead(['beta']), 'beta').refuse, /at its limit.*skipped/);
  assert.match(partGate(lead(['alpha']), 'alpha', { running: 1, atOnce: 1 }).refuse, /at most 1 at once/);
  assert.deepEqual(partGate(lead(['alpha']), 'alpha', { running: 1, atOnce: 2 }), { ok: true });
});

test('where Tia leads: only a ticked provider she is allowed, and one billed by use only at "Hands off"', () => {
  const s = lead(['alpha', 'paid'], { byTia: true });
  assert.match(partGate(s, 'alpha', { tia: { allowed: ['main'], level: 'work' } }).refuse, /Tia may not use/);
  assert.deepEqual(partGate(s, 'alpha', { tia: { allowed: ['alpha'], level: 'handsoff', dailyCapUsd: 1 } }), { ok: true, hold: 1 });
  assert.match(partGate(s, 'paid', { tia: { allowed: ['paid'], level: 'work' }, paidOk: true }).card, /billed by use/, 'the owner\'s word for himself is not hers');
  // Hands off spends only inside the daily limit for paid use he set: none set, a card; one set, the caller holds it.
  assert.match(partGate(s, 'paid', { tia: { allowed: ['paid'], level: 'handsoff' } }).card, /no daily limit for paid use is set: the owner's OK comes first/);
  assert.deepEqual(partGate(s, 'paid', { tia: { allowed: ['paid'], level: 'handsoff', dailyCapUsd: 3 } }), { ok: true, hold: 3 });
  // Her own rule for every API provider (a gateway too): paid per token below Hands off, as her own start there is.
  assert.match(partGate(s, 'alpha', { tia: { allowed: ['alpha'], level: 'work' } }).card, /billed by use/);
  assert.match(partGate(s, 'alpha', { tia: { allowed: ['alpha'], level: 'handsoff' } }).card, /no daily limit for paid use/);
  assert.deepEqual(partGate(s, 'alpha', { tia: { allowed: ['alpha'], level: 'handsoff', dailyCapUsd: 2 } }), { ok: true, hold: 2 });
  assert.deepEqual(partGate(lead(['alpha']), 'alpha'), { ok: true }, 'the owner\'s own chat: a gateway is not billed by use');
});
