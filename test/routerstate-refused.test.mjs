// A refused sign-in (Claude answered 401 or 403 to a provider's own key) is kept apart from a limit: the provider is not
// signed in, and the page says so. A new sign-in or the next good answer takes the refusal away.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('routerstate-refused');
test.after(() => box.cleanup());

const RS = await import('../src/routerstate.mjs');
const P = await import('../src/profiles.mjs');

P.writeProfile('subx', { label: 'Sub X', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-for-subx' } });

test('a key Claude refused is not signed in; cleared, it is again', () => {
  const p = P.readProfile('subx');
  assert.equal(RS.providerFacts(p).signedIn, true);
  RS.noteRefused('subx', 'Claude answered 401', 1000);
  assert.equal(RS.refusedOf('subx').at, 1000);
  const f = RS.providerFacts(p);
  assert.equal(f.signedIn, false);
  assert.equal(f.signinRefused.at, 1000);
  assert.equal(RS.clearRefused('subx'), true);
  assert.equal(RS.clearRefused('subx'), false);
  assert.equal(RS.providerFacts(p).signedIn, true);
  assert.equal(RS.providerFacts(p).signinRefused, undefined);
});

test('a provider signed out here (no key line) says so', () => {
  P.writeProfile('subout', { label: 'Out', signin: 'claude', env: {} });
  const p = P.readProfile('subout');
  assert.equal(p.kind, 'subscription');
  const f = RS.providerFacts(p);
  assert.equal(f.signedIn, false);
  assert.equal(f.signedOut, true);
});

test('a stored sign-in (kind login) that Claude refused shows as refused too, with its time', () => {
  P.writeProfile('storedx', { label: 'Stored X', env: {} });
  const p = P.readProfile('storedx');
  assert.equal(p.kind, 'login');
  assert.equal(RS.providerFacts(p).signinRefused, undefined);
  RS.noteRefused('storedx', 'Claude answered 401', 2000);
  const f = RS.providerFacts(p);
  assert.equal(f.signedIn, false);
  assert.equal(f.signinRefused.at, 2000);
  RS.clearRefused('storedx');
  assert.equal(RS.providerFacts(p).signinRefused, undefined);
});
