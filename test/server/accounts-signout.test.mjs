// Sign out of a provider that has its own key: the key line goes, the rest of the file stays, the kind stays
// "subscription" (signed out), and Sign in again writes a key back. Page caller only; other kinds are refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('accounts-signout');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const P = await import('../../src/profiles.mjs');
const RS = await import('../../src/routerstate.mjs');
const { accountsFeature } = await import('../../src/server/accounts.mjs');

P.writeProfile('s2', { label: 'Second', prerun: 'true', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-s2', EXTRA_LINE: 'kept' } });
P.writeProfile('k1', { label: 'Key', env: { ANTHROPIC_API_KEY: 'made-up-key-k1' } });
saveConfig({ autoSwitch: { enabled: true, order: ['k1', 's2'] } });

let who = 'page';
const feature = accountsFeature({ readJson: async (req) => req.body, state: async () => ({ profiles: [] }), caller: () => who, clientIp: () => '127.0.0.1', config: () => ({}) }, { gateways: [] });
const route = (method, url) => {
  const r = feature.routes.find(([m, re]) => m === method && re.test(url));
  return (body) => r[2]({ body }, url.match(r[1]));
};

test('sign out removes the key line only, keeps the order and the other lines', async () => {
  RS.noteRefused('s2', 'x');
  assert.deepEqual(await route('POST', '/api/accounts/s2/signout')({}), { ok: true });
  const text = fs.readFileSync(`${box.profiles}/s2.env`, 'utf8');
  assert.ok(!text.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(/SIGNIN=claude/.test(text) && /LABEL=Second/.test(text) && /EXTRA_LINE=kept/.test(text) && /PRERUN=true/.test(text));
  const p = P.readProfile('s2');
  assert.equal(p.kind, 'subscription');
  assert.equal(RS.providerFacts(p).signedOut, true);
  assert.equal(RS.refusedOf('s2'), null);
  const list = (await route('GET', '/api/accounts')()).accounts.find((a) => a.name === 's2');
  assert.equal(list.kind, 'subscription');
  assert.ok(list.inAuto, 'its place in the order is kept');
});

test('an API key is not signed out, and only the page may press it', async () => {
  await assert.rejects(() => route('POST', '/api/accounts/k1/signout')({}), (e) => e.status === 400);
  who = 'token';
  await assert.rejects(() => route('POST', '/api/accounts/s2/signout')({}), (e) => e.status === 403);
  who = 'page';
});
