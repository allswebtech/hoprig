// A Claude subscription token (it starts with sk-ant-oat) pasted as an API key or a gateway token is refused, and one that
// an older Hoprig saved that way is never sent: not by the accounts pages (probe, test, list of models), not by the
// provider check, not by the router. One place per test; the prompts of `hop add` are pinned by their source text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const box = sandbox('subkey');
test.after(() => box.cleanup());
const P = await import('../../src/profiles.mjs');
const { cleanKey, accountsFeature } = await import('../../src/server/accounts.mjs');
const { isSubscriptionToken, SUBSCRIPTION_TOKEN_SENTENCE } = await import('../../src/secretenv.mjs');
const { checkable } = await import('../../src/providers/check.mjs');
const { upstreamRequest } = await import('../../src/router.mjs');
const { upstreamAuth } = await import('../../src/gateway/index.mjs');
const { relayable } = await import('../../src/hubprov/list.mjs');

const TOKEN = ['sk-ant', 'oat01-made-up-', 'x'.repeat(24)].join('-'); // built at run time: no source line looks like a key
const calls = [];
const fetchStub = async (...a) => { calls.push(String(a[0])); throw new Error('no network in this test'); };
let who = 'page';
const feature = accountsFeature({ readJson: async (req) => req.body, state: async () => ({ profiles: [] }), caller: () => who, clientIp: () => '127.0.0.1', config: () => ({}) }, { gateways: [], fetch: fetchStub });
const route = (method, url) => {
  const r = feature.routes.find(([m, re]) => m === method && re.test(url));
  return (body) => r[2]({ body }, url.match(r[1]));
};

test('one shared test of the prefix, and one plain sentence', () => {
  assert.equal(isSubscriptionToken(TOKEN), true);
  assert.equal(isSubscriptionToken(`  ${TOKEN}`), true);
  assert.equal(isSubscriptionToken('sk-ant-api03-fake'), false);
  assert.equal(isSubscriptionToken(undefined), false);
  assert.match(SUBSCRIPTION_TOKEN_SENTENCE, /Sign in or Add Claude account/);
});

test('cleanKey refuses it with the sentence', () => {
  assert.throws(() => cleanKey(TOKEN), (e) => e.status === 400 && e.message === SUBSCRIPTION_TOKEN_SENTENCE);
  assert.equal(cleanKey('made-up-api-key-123'), 'made-up-api-key-123');
});

test('Add provider: a pasted token is refused before any request is made', async () => {
  await assert.rejects(() => route('POST', '/api/accounts/probe')({ baseUrl: 'https://api.example.com', key: TOKEN }), (e) => e.status === 400 && e.message === SUBSCRIPTION_TOKEN_SENTENCE);
  assert.deepEqual(calls, []);
});

for (const [kind, env] of [['an API key', { ANTHROPIC_API_KEY: TOKEN }], ['a gateway token', { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: 'https://gw.example.com' }]]) {
  test(`a provider file written before (${kind}) is never sent: the test route, the probe of its models and the check`, async () => {
    P.writeProfile('older', { label: 'Older', env });
    const prof = P.readProfile('older');
    await assert.rejects(() => route('POST', '/api/accounts/older/test')({}), (e) => e.status === 400 && /no key stored/.test(e.message));
    await assert.rejects(() => route('POST', '/api/accounts/probe')({ account: 'older' }), (e) => e.status === 400);
    assert.deepEqual(calls, [], 'nothing was sent');
    assert.equal(checkable(prof), false);
    assert.equal(upstreamRequest(prof, { isIdentity: false, rest: '/v1/messages', headers: {}, body: Buffer.from('{}') }), null);
    assert.equal(upstreamRequest(prof, { isIdentity: true, rest: '/v1/messages', headers: {}, body: Buffer.from('{}') }), null, 'not even as the session identity');
    assert.equal(relayable(prof), false);
    P.deleteProfile('older');
  });
}

test('an ordinary key still works in all of them', () => {
  P.writeProfile('plain', { label: 'Plain', env: { ANTHROPIC_API_KEY: 'made-up-api-key-123' } });
  const prof = P.readProfile('plain');
  assert.equal(checkable(prof), true);
  const r = upstreamRequest(prof, { isIdentity: false, rest: '/v1/messages', headers: {}, body: Buffer.from('{}') });
  assert.equal(r.headers['x-api-key'], 'made-up-api-key-123');
  P.deleteProfile('plain');
});

test('the gateway refuses it as a token too (the same test of the prefix)', () => {
  assert.equal(upstreamAuth({ kind: 'api', env: { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000' } }, 9000), null);
});

test('the two prompts of hop add that take a key refuse it before anything is saved', () => {
  const text = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'menu.mjs'), 'utf8').split('\n');
  const sets = text.map((l, i) => [l, i]).filter(([l]) => /env\.ANTHROPIC_(API_KEY|AUTH_TOKEN) = /.test(l));
  assert.equal(sets.length, 2, 'the two prompts of a key');
  for (const [, i] of sets) assert.ok(text.slice(Math.max(0, i - 6), i).some((l) => /isSubscriptionToken\(/.test(l)), `line ${i + 1} sets a key without the refusal before it`);
  assert.ok(text.some((l) => /SUBSCRIPTION_TOKEN_SENTENCE/.test(l)));
});

test('a token stored as an OpenAI key is never sent, never relayed, and refused by hop add', async () => {
  P.writeProfile('oaitok', { label: 'Oaitok', kind: 'openai', env: { OPENAI_API_KEY: TOKEN } });
  const prof = P.readProfile('oaitok');
  await assert.rejects(() => route('POST', '/api/accounts/oaitok/test')({}), (e) => e.status === 400 && /no key stored/.test(e.message));
  await assert.rejects(() => route('POST', '/api/accounts/probe')({ account: 'oaitok' }), (e) => e.status === 400);
  assert.deepEqual(calls, [], 'nothing was sent');
  assert.equal(relayable(prof), false);
  P.deleteProfile('oaitok');
  const text = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'menu.mjs'), 'utf8').split('\n');
  const i = text.findIndex((l) => /env\.OPENAI_API_KEY = /.test(l));
  assert.ok(i > 0 && text.slice(Math.max(0, i - 20), i).some((l) => /isSubscriptionToken\(/.test(l)), 'the OpenAI prompt refuses it before it saves');
});
