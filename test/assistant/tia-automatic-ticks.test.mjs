// Automatic picks only among the subscriptions she may really think on: one he left unticked under "Providers she may
// use" is never hers, one whose sign-in is known to be gone is passed over (she would answer nothing on it, and it is
// not "at its limit"), and a stored sign-in the facts mark as billed by use stays behind the cap like any key.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTia } from '../../src/assistant/tia.mjs';

const sub = (name, extra = {}) => ({ name, label: `Plan ${name}`, kind: 'subscription', tools: ['claude'], ...extra });
const key = { name: 'key', label: 'Key', kind: 'api', paid: true, tools: ['claude'] };

test('a subscription he unticked is never Automatic\'s pick, also when it comes first', () => {
  const acc = { profiles: [sub('alpha'), sub('beta')], autoSwitch: { enabled: false } };
  const t = resolveTia({ enabled: true, accounts: ['beta'] }, acc);
  assert.deepEqual(t.allowed, ['beta']);
  assert.equal(t.runsOn, 'beta');
  assert.equal(t.subscription, 'beta', 'the "Use …" offer names one he left out');
  // Every ticked subscription at its limit: the unticked one is not taken in its place, nor named in the line.
  const limited = { profiles: [sub('alpha'), sub('beta', { limited: { until: Date.now() + 3600_000 } })], autoSwitch: { enabled: false } };
  const l = resolveTia({ accounts: ['beta'] }, limited);
  assert.equal(l.runsOn, null);
  assert.deepEqual(l.subsLimited.names, ['beta']);
  // His default list (nothing chosen) still takes every subscription.
  assert.equal(resolveTia({}, acc).runsOn, 'alpha');
});

test('a subscription whose sign-in is gone is passed over, not called at its limit', () => {
  const acc = { profiles: [sub('alpha', { kind: 'login', signedIn: false }), sub('beta'), key], autoSwitch: { enabled: true, order: ['beta', 'key'] } };
  const t = resolveTia({}, acc);
  assert.equal(t.runsOn, 'beta');
  assert.equal(t.subscription, 'beta');
  // Only that one: no subscription she can think on, so Auto mode as with none (behind the cap), and no limit line.
  const only = { profiles: [sub('alpha', { kind: 'login', signedIn: false }), key], autoSwitch: { enabled: true, order: ['key'] } };
  const o = resolveTia({}, only);
  assert.equal(o.runsOn, 'auto');
  assert.equal(o.subsLimited, null);
  assert.equal(o.subscription, null);
  // A sign-in nobody checked yet (null) is not taken as gone.
  assert.equal(resolveTia({}, { profiles: [sub('alpha', { kind: 'login', signedIn: null })], autoSwitch: { enabled: false } }).runsOn, 'alpha');
});

test('a stored sign-in marked as billed by use is not a subscription for Automatic', () => {
  const acc = { profiles: [sub('console', { kind: 'login', paid: true }), sub('beta')], autoSwitch: { enabled: false } };
  assert.equal(resolveTia({}, acc).runsOn, 'beta');
});
