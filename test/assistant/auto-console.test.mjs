// Auto mode with "Also use pay-per-use providers" off and a stored sign-in on a Console account's key in its order
// (src/routerstate.mjs billedLogin). That sign-in is billed by use, so Auto mode leaves it out of the order it uses
// (src/autoswitch.mjs usableOrder): the router serves nothing through it and no move at a limit goes to it, as the
// switch's help on the Providers page says. With the switch on it takes part. The sign-in check is remembered as its
// answer; the router talks to a stand-in endpoint only.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('auto-console');
// A stand-in for Anthropic's API: it counts what reaches it.
const seen = [];
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
const upPort = await new Promise((r) => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
process.env.HOPRIG_ANTHROPIC_URL = `http://127.0.0.1:${upPort}`;

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { deleteProfile, listProfiles, publicProfile, writeProfile } = await import('../../src/profiles.mjs');
const A = await import('../../src/autoswitch.mjs');
const RS = await import('../../src/routerstate.mjs');
const { createRouter } = await import('../../src/router.mjs');
const { paidName } = await import('../../src/assistant/spend.mjs');
const { paidTo } = await import('../../src/operator/money.mjs');

writeProfile('acct', { label: 'Account' }); // the stored sign-in: no key in its file
writeProfile('plan', { label: 'Plan', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
writeProfile('key', { label: 'Shop key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });

const KEY = 'k'.repeat(48);
const router = createRouter({ key: KEY, version: 'test' });
const rPort = await new Promise((r) => router.listen(0, '127.0.0.1', () => r(router.address().port)));
test.after(() => {
  router.close(); upstream.close();
  router.closeAllConnections(); upstream.closeAllConnections();
  box.cleanup();
});
// One model request as Claude Code sends it to Auto mode (no "/as/<provider>": the router picks).
const ask = () => fetch(`http://127.0.0.1:${rPort}/${KEY}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer stand-in' }, body: '{"model":"x","messages":[]}',
});

// The accounts as the dashboard lists them (/api/state, the digest's tellwire.mjs): the sign-in's paid mark included.
const accounts = () => ({ profiles: listProfiles().map((p) => ({ ...publicProfile(p), ...RS.providerFacts(p) })), autoSwitch: A.getAutoSwitch() });

test('a Console sign-in in Auto mode\'s order with pay-per-use off: the router serves nothing through it', async () => {
  RS.rememberLogin({ loggedIn: true, method: 'api_key' });
  saveConfig({ autoSwitch: { enabled: true, order: ['acct'], payPerUse: false } });
  assert.equal(accounts().profiles.find((p) => p.name === 'acct').paid, true, 'the page marks the sign-in billed by use');
  assert.deepEqual(A.usableOrder(), [], 'Auto mode leaves it out');
  seen.length = 0;
  const r = await ask();
  assert.equal(r.status, 503, 'no provider Auto mode may use');
  await r.text();
  assert.equal(seen.length, 0, 'nothing reached the API through the sign-in');
  // Never chosen (older settings): a sign-in that became billed by use does not turn paid use on by itself.
  saveConfig({ autoSwitch: { enabled: true, order: ['plan', 'acct'] } });
  assert.equal(A.getAutoSwitch().payPerUse, false);
  assert.deepEqual(A.usableOrder(), ['plan']);
  // A session on the subscription at its limit is not moved onto the sign-in (watcher.mjs planAutoSwitch asks this).
  assert.equal(A.nextProfile('plan'), null);
});

test('moving the rows of the order does not turn pay-per-use on; turning it on lets the sign-in serve', async () => {
  RS.rememberLogin({ loggedIn: true, method: 'api_key' }, Date.now() + 120_000);
  saveConfig({ autoSwitch: { enabled: true, order: ['plan', 'acct'], payPerUse: false } });
  assert.equal(A.setAutoSwitch({ order: ['acct', 'plan'] }).payPerUse, false, 'the sign-in was in the order already');
  assert.deepEqual(A.usableOrder(), ['plan']);
  assert.deepEqual(A.setAutoSwitch({ payPerUse: true }).order, ['acct', 'plan', 'key'], 'it stays, the paid key joins at the end');
  assert.deepEqual(A.usableOrder(), ['acct', 'plan', 'key']);
  assert.equal(A.nextProfile('plan'), 'key');
  assert.equal(paidName('auto', accounts()), true, 'on: Auto mode may spend, for Tia\'s facts');
  assert.equal(paidTo('auto', accounts()), true, 'and for the Operator\'s');
  saveConfig({ autoSwitch: { enabled: true, order: ['acct'], payPerUse: true } });
  seen.length = 0;
  const r = await ask();
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(seen.length, 1, 'served through the sign-in, as he allowed');
  // Off again takes every provider billed by use out of the saved order, the sign-in too.
  saveConfig({ autoSwitch: { enabled: true, order: ['acct', 'plan', 'key'], payPerUse: true } });
  assert.deepEqual(A.setAutoSwitch({ payPerUse: false }).order, ['plan']);
  assert.equal(loadConfig().autoSwitch.payPerUse, false);
});

test('pay-per-use off still drops a key paid by its own file, and a claude.ai sign-in stays in the order', () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['plan', 'key'], payPerUse: false } });
  assert.deepEqual(A.usableOrder(), ['plan']);
  assert.equal(paidName('auto', accounts()), false, 'the router leaves the key out: nothing is spent on it');
  RS.rememberLogin({ loggedIn: true, method: 'claude.ai' }, Date.now() + 240_000);
  saveConfig({ autoSwitch: { enabled: true, order: ['acct', 'plan'], payPerUse: false } });
  assert.deepEqual(A.usableOrder(), ['acct', 'plan']);
  assert.equal(paidName('auto', accounts()), false);
});

test('a Console sign-in alone in the order: Auto mode spends nothing while pay-per-use is off, and may while it is on', () => {
  RS.rememberLogin({ loggedIn: true, method: 'api_key' }, Date.now() + 360_000);
  saveConfig({ autoSwitch: { enabled: true, order: ['acct'], payPerUse: false } });
  assert.deepEqual(A.usableOrder(), []);
  assert.deepEqual(A.billedOutOfOrder(), ['acct'], 'left out only for being billed by use');
  assert.equal(paidName('auto', accounts()), false, 'the router leaves the sign-in out: Tia\'s facts do not call Auto paid');
  assert.equal(paidTo('auto', accounts()), false, 'nor the Operator\'s');
  assert.equal(paidName('acct', accounts()), true, 'the sign-in itself stays billed by use');
  saveConfig({ autoSwitch: { enabled: true, order: ['acct'], payPerUse: true } });
  assert.deepEqual(A.billedOutOfOrder(), []);
  assert.equal(paidName('auto', accounts()), true, 'on: it serves, so Auto mode may spend');
  // A key paid by its own file: as before.
  saveConfig({ autoSwitch: { enabled: true, order: ['key'], payPerUse: false } });
  assert.deepEqual(A.billedOutOfOrder(), ['key']);
  assert.equal(paidName('auto', accounts()), false);
  saveConfig({ autoSwitch: { enabled: true, order: ['key'], payPerUse: true } });
  assert.equal(paidName('auto', accounts()), true);
  // An API provider through a gateway is not marked paid: the router keeps it, so it still counts (the safe side).
  writeProfile('gw', { label: 'Gateway', env: { ANTHROPIC_BASE_URL: 'https://gateway.example/v1', ANTHROPIC_AUTH_TOKEN: 'gateway-token' } });
  try {
    saveConfig({ autoSwitch: { enabled: true, order: ['acct', 'gw'], payPerUse: false } });
    assert.deepEqual([A.usableOrder(), A.billedOutOfOrder()], [['gw'], ['acct']]);
    assert.equal(paidName('auto', accounts()), true);
  } finally {
    deleteProfile('gw');
  }
});

test('a running Auto session whose identity is the Console sign-in: nothing is spent through it while pay-per-use is off', async () => {
  // The URL a session started on that identity carries (launch.mjs autoProfile): "/as/acct".
  const asAcct = (rest = '/v1/messages') => fetch(`http://127.0.0.1:${rPort}/${KEY}/as/acct${rest}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer stand-in' }, body: '{"model":"x","messages":[]}',
  });
  const said = 'hoprig: this session runs as Account, which is billed by use, and "Also use pay-per-use providers" is off, so Auto mode does not use it: turn that switch on on the Providers page, or start the session again under Auto mode.';
  RS.rememberLogin({ loggedIn: true, method: 'api_key' }, Date.now() + 480_000);
  // Off, and never chosen with a subscription first (the sign-in became billed by use while it stood in the order).
  for (const autoSwitch of [{ enabled: true, order: ['acct'], payPerUse: false }, { enabled: true, order: ['plan', 'acct'] }]) {
    saveConfig({ autoSwitch });
    seen.length = 0;
    const r = await asAcct();
    assert.equal(r.status, 503, JSON.stringify(autoSwitch));
    assert.equal((await r.json()).error.message, said);
    assert.equal(seen.length, 0, 'nothing reached the API through the sign-in');
    assert.equal(paidName('auto', accounts()), false, 'so Tia\'s facts say true: Auto mode spends nothing');
    assert.equal(paidTo('auto', accounts()), false, 'and the Operator\'s');
  }
  // On: the session goes on through the sign-in, as he allowed, and Auto mode counts as paid.
  saveConfig({ autoSwitch: { enabled: true, order: ['acct'], payPerUse: true } });
  seen.length = 0;
  const r = await asAcct();
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(seen.length, 1);
  assert.equal(paidName('auto', accounts()), true);
});

test('the Providers page says what Auto mode does with a provider billed by use', async () => {
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
  const { PAY_PER_USE_HELP, listRowSub, orderRowSub } = await import('../../web/accounts.js');
  assert.match(PAY_PER_USE_HELP, /a Claude sign-in on a Console account \(billed by use too\)/);
  // A sign-in already in the order stays where it is when the switch goes on (the second test above): only those not
  // yet in the order are added at its end.
  assert.match(PAY_PER_USE_HELP, /take part in Auto mode only while this is on\. Turning it on puts them at the end of the order, if they are not in it yet\./);
  assert.doesNotMatch(PAY_PER_USE_HELP, /go at the end of the order/);
  // A sign-in billed by use is named so once, never "Subscription".
  const signIn = { name: 'acct', label: 'Account', kind: 'login', paid: true, signedIn: true };
  assert.equal(orderRowSub(signIn, false), 'Claude sign-in billed by use (Console account) · Not used while pay-per-use is off');
  assert.equal(orderRowSub(signIn, true), 'Claude sign-in billed by use (Console account) · Available');
  assert.equal(orderRowSub({ name: 'plan', label: 'Plan', kind: 'subscription' }, false), 'Subscription · Available');
  assert.equal(orderRowSub({ name: 'key', label: 'Key', kind: 'api', paid: true }, false), 'API · Billed by use · not used while pay-per-use is off');
  // The list under the order says the same as the order's row.
  assert.equal(listRowSub(signIn, false), orderRowSub(signIn, false));
  assert.equal(listRowSub(signIn, true), orderRowSub(signIn, true));
});
