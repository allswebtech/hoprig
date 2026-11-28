// The hub's subscription row on a linked computer: until this computer's own sign-in is seen it is NOT signed in, so the
// row says Sign in here and a new session does not start on it before the hub's working providers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

sandbox('hubprov-signinhere');
const { providerFacts } = await import('../../src/routerstate.mjs');
const { chooseDefault } = await import('../../src/defaultprovider.mjs');

test('not known is not signed in for the hub subscription row; an ordinary sign-in stays as it was', () => {
  assert.equal(providerFacts({ name: 'hub-subscription', kind: 'login', signinHere: true, hub: true }).signedIn, false);
  assert.equal(providerFacts({ name: 'plain', kind: 'login' }).signedIn, null);
});

test('the default is a hub provider that works, not the subscription that needs a sign-in here', () => {
  const sub = { name: 'hub-subscription', kind: 'login', hub: true, signinHere: true, signedIn: false, tools: ['claude'] };
  const api = { name: 'hub-api', kind: 'api', hub: true, tools: ['claude'] };
  assert.equal(chooseDefault({ profiles: [sub, api] }), 'hub-api');
  assert.equal(chooseDefault({ profiles: [sub] }), 'hub-subscription', 'alone it is still the only choice');
});

test('a hub provider whose hub is offline is passed over while another works; alone it is still the choice', () => {
  const down = { name: 'hub-api', kind: 'api', hub: true, hubOffline: true, tools: ['claude'] };
  const own = { name: 'mine', kind: 'api', tools: ['claude'] };
  assert.equal(chooseDefault({ profiles: [down, own] }), 'mine');
  assert.equal(chooseDefault({ profiles: [down] }), 'hub-api');
});

test('the public profile and the accounts list carry the hub offline mark and its name', async () => {
  const { publicProfile } = await import('../../src/profiles.mjs');
  assert.equal(publicProfile({ name: 'hub-x', label: 'X', kind: 'api', env: {}, hub: true, hubOffline: true }).hubOffline, true);
  assert.equal(publicProfile({ name: 'hub-x', label: 'X', kind: 'api', env: {}, hub: true }).hubOffline, undefined);
});
