// Auto mode on, and the provider Auto would run on is slow or refusing now (as the router measured it): a new
// session starts on another provider that is free of charge, signed in, not at its limit and not slow itself.
// Otherwise it stays Auto. Speed never adds a provider the money rules leave out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-defspeed-')));
Object.assign(process.env, { HOPRIG_CONFIG_DIR: path.join(tmp, 'config'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), HOPRIG_PROFILES_DIR: path.join(tmp, 'profiles') });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const D = await import('../src/defaultprovider.mjs');

const slow = { verdict: 'slow', seconds: 9 };
// The owner's settings: Auto on, its order one gateway; the stored sign-in outside the order, signed in and free.
const gw = (speed) => ({ name: 'gw', kind: 'api', paid: false, limited: null, tools: ['claude'], speed });
const sub = (o = {}) => ({ name: 'sub', kind: 'login', paid: false, limited: null, signedIn: true, tools: ['claude'], ...o });
const autoState = { name: 'auto', kind: 'auto', virtual: true };
const auto = { enabled: true, order: ['gw'], payPerUse: false };
const pick = (profiles, a = auto) => D.chooseDefault({ profiles: [autoState, ...profiles], auto: a });

test('a slow or refusing gateway in Auto\'s order, a free signed-in subscription beside it: the subscription', () => {
  assert.equal(pick([gw(slow), sub()]), 'sub');
  assert.equal(pick([gw({ verdict: 'refusing' }), sub()]), 'sub');
});

test('the gateway fast, or not measured yet: Auto', () => {
  assert.equal(pick([gw({ verdict: 'fast', seconds: 2 }), sub()]), 'auto');
  assert.equal(pick([gw(null), sub()]), 'auto');
});

test('a provider billed by use is never the faster default, also while pay-per-use is on', () => {
  const key = { name: 'key', kind: 'api', paid: true, limited: null, tools: ['claude'], speed: { verdict: 'fast', seconds: 1 } };
  assert.equal(pick([gw(slow), key]), 'auto');
  assert.equal(pick([gw(slow), key], { ...auto, payPerUse: true }), 'auto', 'no money limit is read here');
  assert.equal(pick([gw(slow), sub(), key], { ...auto, payPerUse: true }), 'sub', 'a free one never measured before a fast paid key');
  assert.equal(pick([gw(slow), sub({ paid: true })]), 'auto', 'a sign-in billed by use is billed by use');
});

test('the other provider at its limit, signed out, slow itself or not serving Claude Code: Auto', () => {
  assert.equal(pick([gw(slow), sub({ limited: { until: Date.now() + 3600_000 } })]), 'auto');
  assert.equal(pick([gw(slow), sub({ signedIn: false })]), 'auto');
  assert.equal(pick([gw(slow), sub({ signedIn: null })]), 'auto', 'a sign-in nobody checked (or of a folder of its own) is not known');
  assert.equal(pick([gw(slow), sub({ signedIn: undefined })]), 'auto');
  assert.equal(pick([gw(slow), sub({ speed: { verdict: 'slow', seconds: 7 } })]), 'auto');
  assert.equal(pick([gw(slow), sub({ tools: ['opencode'] })]), 'auto');
});

test('Auto runs on a free subscription of its order: only its speed counts, not the gateway behind it', () => {
  const a = { ...auto, order: ['sub', 'gw'] };
  assert.equal(pick([gw(slow), sub()], a), 'auto');
  assert.equal(pick([gw(slow), sub({ speed: slow }), { name: 'team', kind: 'subscription', paid: false, limited: null, signedIn: true, tools: ['claude'] }], a), 'team');
});

test('among several that may be used, the one measured fastest', () => {
  const t = (name, speed) => ({ name, kind: 'subscription', paid: false, limited: null, signedIn: true, tools: ['claude'], speed });
  assert.equal(pick([gw(slow), t('a', null), t('b', { verdict: 'fast', seconds: 3 }), t('c', { verdict: 'fast', seconds: 1.5 })]), 'c');
});
