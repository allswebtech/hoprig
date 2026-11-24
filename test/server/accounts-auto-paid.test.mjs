// "Use in Auto mode" on a provider billed by use (a Claude sign-in on a Console account) while "Also use pay-per-use
// API keys" is off: the press turns that switch on (src/autoswitch.mjs), so the provider's page says so before the
// press, and the toast after it names the switch. The route answers what it turned on. A stand-in sign-in only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('accounts-auto-paid');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const A = await import('../../src/autoswitch.mjs');
const RS = await import('../../src/routerstate.mjs');
const { accountsFeature } = await import('../../src/server/accounts.mjs');

writeProfile('acct', { label: 'Account' }); // the stored sign-in
writeProfile('plan', { label: 'Plan', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
RS.rememberLogin({ loggedIn: true, method: 'api_key' }, Date.now() + 600_000); // a Console account's key: billed by use

const feature = accountsFeature({ readJson: async (req) => req.body, state: async () => ({ profiles: [] }), caller: () => null, clientIp: () => '127.0.0.1', config: () => ({}) }, { gateways: [] });
const route = (method, url) => {
  const r = feature.routes.find(([m, re]) => m === method && re.test(url));
  return (body) => r[2]({ body }, url.match(r[1]));
};

test('the auto route says when its press turned pay-per-use on', async () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['plan'], payPerUse: false } });
  const on = await route('POST', '/api/accounts/acct/auto')({ on: true });
  assert.deepEqual(on.order, ['plan', 'acct']);
  assert.equal(on.payPerUse, true);
  assert.equal(on.payPerUseTurnedOn, true, 'the sign-in billed by use turned it on');
  const off = await route('POST', '/api/accounts/acct/auto')({ on: false });
  assert.equal(off.payPerUseTurnedOn, false);
  // Already on: nothing new is turned on.
  const again = await route('POST', '/api/accounts/acct/auto')({ on: true });
  assert.equal(again.payPerUseTurnedOn, false);
  // A subscription new to the order turns nothing on.
  saveConfig({ autoSwitch: { enabled: true, order: [], payPerUse: false } });
  RS.rememberLogin({ loggedIn: true, method: 'claude.ai' }, Date.now() + 700_000);
  const plain = await route('POST', '/api/accounts/plan/auto')({ on: true });
  assert.equal(plain.payPerUseTurnedOn, false);
  assert.equal(A.getAutoSwitch().payPerUse, false);
  RS.rememberLogin({ loggedIn: true, method: 'api_key' }, Date.now() + 800_000);
});

test('the accounts answer says whether pay-per-use is on, for the provider\'s page', async () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['plan'], payPerUse: false } });
  assert.equal((await route('GET', '/api/accounts')()).payPerUse, false);
  saveConfig({ autoSwitch: { enabled: true, order: ['plan'], payPerUse: true } });
  assert.equal((await route('GET', '/api/accounts')()).payPerUse, true);
});

test('the provider\'s page says it before the press, and the toast names it after', async () => {
  class FakeNode {}
  class FakeElement extends FakeNode {
    constructor(t) {
      super();
      Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener() {}
    append(...n) { this.children.push(...n); }
    replaceChildren(...n) { this.children = n; }
  }
  globalThis.Node ??= FakeNode;
  globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
  const { autoHelp, autoToast } = await import('../../web/accounts.js');
  const signIn = { name: 'acct', label: 'Account', kind: 'login', paid: true, inAuto: false };
  assert.match(autoHelp(signIn, false), /This provider is billed by use: turning this on also turns on "Also use pay-per-use providers"/);
  assert.doesNotMatch(autoHelp(signIn, true), /billed by use/, 'already on: nothing more is turned on');
  assert.doesNotMatch(autoHelp({ ...signIn, inAuto: true }, false), /billed by use/, 'in the order: the press only takes it out');
  assert.doesNotMatch(autoHelp({ name: 'plan', label: 'Plan', kind: 'subscription' }, false), /billed by use/);
  assert.equal(autoToast(signIn, true, { payPerUseTurnedOn: true }), 'Account is used in Auto mode. "Also use pay-per-use providers" is now on, so Auto mode can spend money here.');
  assert.equal(autoToast(signIn, true, { payPerUseTurnedOn: false }), 'Account is used in Auto mode');
  assert.equal(autoToast(signIn, false, {}), 'Account is no longer used in Auto mode');
});
