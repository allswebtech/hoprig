import assert from 'node:assert/strict';
import test from 'node:test';
import { detectProvider } from '../../src/operator/detect/provider.mjs';
import { NOW, ago } from './fixtures/cases.mjs';

const plan = (name, five, week, extra = {}) => ({ name, signedIn: true, usage: { fiveHour: { pct: five, resetsAt: '2026-03-10T16:00:00Z' }, week: { pct: week, resetsAt: '2026-03-14T09:00:00Z' }, at: ago(2) }, ...extra });

test('a window at 78 % and a week at 75 % is not yet near', () => {
  assert.deepEqual(detectProvider({ providers: [plan('plan-a', 78, 75)] }, { now: NOW }), []);
});

test('80 % is near (information), 100 % is reached (stopped work), with the reset time', () => {
  const [near] = detectProvider({ providers: [plan('plan-a', 80, 40)] }, { now: NOW });
  assert.equal(near.class, 'info');
  assert.deepEqual(near.facts, ['5-hour limit: 80% used, resets in 2 h']);
  const [full] = detectProvider({ providers: [plan('plan-b', 60, 100)] }, { now: NOW });
  assert.equal(full.class, 'stopped');
  assert.deepEqual(full.facts, ['Weekly limit: 100% used, resets in 3 days']);
});

test('a sign-in that is gone is stopped work and leads to Providers', () => {
  const [it] = detectProvider({ providers: [plan('plan-c', 10, 10, { signedIn: false })] }, { now: NOW });
  assert.equal(it.class, 'stopped');
  assert.match(it.facts[0], /sign-in is gone/);
  assert.equal(it.acts[0].href, '#/providers/plan-c', 'the sign-in opens that provider own page');
  assert.equal(it.acts[0].label, 'Open Providers to sign in');
  const [near] = detectProvider({ providers: [plan('plan-d', 90, 10)] }, { now: NOW });
  assert.equal(near.acts[0].href, '#/providers', 'a limit opens the list');
});

test('the limit line has the words of Providers, a reset in minutes, and none when the reset has passed', () => {
  const two = detectProvider({ providers: [{ name: 'p', signedIn: true, usage: { fiveHour: { pct: 96.4, resetsAt: new Date(NOW + 130 * 60_000).toISOString() }, week: { pct: 85, resetsAt: new Date(NOW - 60_000).toISOString() } } }] }, { now: NOW })[0];
  assert.deepEqual(two.facts, ['5-hour limit: 96% used, resets in 2 h 10 min', 'Weekly limit: 85% used']);
  assert.ok(two.facts.every((f) => !/UTC| %/.test(f)));
});

test('a gateway that runs but does not answer its port: restart it', () => {
  const items = detectProvider({ gateways: [
    { name: 'gate', port: 20001, running: true, answers: false, since: ago(6) },
    { name: 'fine', port: 20002, running: true, answers: true },
    { name: 'off', port: 20003, running: false, answers: false },
  ] }, { now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].subject, 'gateway gate');
  assert.equal(items[0].recommended, 'restart-gateway');
  assert.deepEqual(items[0].target, { addon: 'gate', ownerStopped: false }, 'not stopped by the owner');
});

test('a gateway that stopped while providers go through it: restart it; one that nothing uses may be off', () => {
  const items = detectProvider({ gateways: [
    { name: 'down', port: 20004, running: false, installed: true, usedBy: 2, answers: false },
    { name: 'unused', port: 20005, running: false, installed: true, usedBy: 0, answers: null },
  ] }, { now: NOW });
  assert.deepEqual(items.map((i) => i.subject), ['gateway down']);
  assert.deepEqual(items[0].facts, ['the gateway is not running: nothing answers on port 20004', '2 providers go through it and cannot be used']);
  assert.equal(items[0].recommended, 'restart-gateway');
});

test('a gateway that is not running while no session of its providers is open is not started yet: information', () => {
  const [idle, open, unknown] = detectProvider({ gateways: [
    { name: 'idle', port: 20006, running: false, installed: true, usedBy: 1, users: ['plan-g'], live: 0, answers: false },
    { name: 'open', port: 20007, running: false, installed: true, usedBy: 1, users: ['plan-g'], live: 2, answers: false },
    { name: 'unknown', port: 20008, running: false, installed: true, usedBy: 1, users: ['plan-g'], live: null, answers: false },
  ] }, { now: NOW });
  assert.equal(idle.class, 'info');
  assert.deepEqual(idle.facts, ['the gateway is not started: nothing answers on port 20006', 'no session that goes through it is open; the next session of plan-g starts it']);
  assert.equal(open.class, 'stopped');
  assert.equal(open.facts[1], '2 open sessions go through it and cannot work');
  assert.equal(unknown.class, 'stopped', 'sessions that could not be read: it may stop work');
});

test('no usage figures, or no source: nothing', () => {
  assert.deepEqual(detectProvider({ providers: [{ name: 'api-key', signedIn: null, usage: null }] }, { now: NOW }), []);
  assert.deepEqual(detectProvider({ providers: null, gateways: null }, { now: NOW }), []);
});

test('82 % and 91 % are the same near item; reaching 100 % is a change', () => {
  const rev = (pct) => detectProvider({ providers: [plan('plan-a', pct, 10)] }, { now: NOW })[0].rev;
  assert.equal(rev(82), rev(91));
  assert.notEqual(rev(91), rev(100));
});
