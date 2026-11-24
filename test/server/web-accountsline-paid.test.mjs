// Home's near-limit line names where sessions go on the way the limit card under it chooses its main button: a
// provider that costs nothing more first, a paid one only when no other is free, and then with its cost words.
import assert from 'node:assert/strict';
import test from 'node:test';

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
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { accountsLine } = await import('../../web/home.js');
const { limitBox } = await import('../../web/lib.js');
const sub = (label, pct) => ({ name: label.toLowerCase(), label, kind: 'subscription', usage: { fiveHour: { pct } } });
const api = { name: 'api', label: 'API (pay as you go)', kind: 'api', paid: true };

test('a paid provider listed before a free subscription: the line names the subscription', () => {
  const line = accountsLine([
    { machine: null, machineLabel: 'Workstation', profiles: [sub('Claude Max', 96), api, sub('Team plan', 10)] },
    { machine: 'lap', machineLabel: 'Laptop', profiles: [sub('Claude Max', 96)] },
  ], true);
  assert.match(line.text, /sessions can go on with Team plan\.$/);
  assert.doesNotMatch(line.text, /API/);
});

test('only a paid provider is free: it is named with the words every paid way carries', () => {
  const near = accountsLine([{ machineLabel: 'Desk', profiles: [sub('Max', 96), api] }], false);
  assert.match(near.text, /When it runs out, sessions can go on with API \(pay as you go\) · costs money per use\.$/);
  const at = accountsLine([{ machineLabel: 'Desk', profiles: [{ ...sub('Max', 20), limited: {} }, { name: 'key', label: 'Claude API', kind: 'api' }] }], false);
  assert.match(at.text, /Sessions can go on with Claude API · costs money per use\.$/, 'an older computer\'s API provider counts as paid');
});

test('the line says "limit", the word of the limit card and of Providers', () => {
  const line = accountsLine([{ machineLabel: 'Desk', profiles: [sub('Max', 96), sub('Team', 5)] }], false);
  assert.equal(line.text, 'Max is almost used up (96% of its 5-hour limit). When it runs out, sessions can go on with Team.');
  assert.doesNotMatch(line.text, /allowance/);
});

// The limit card's main button, as a person reads it.
const textOf = (n) => (n == null ? '' : typeof n === 'string' ? n : n.text !== undefined ? n.text : (n.children || []).map(textOf).join(''));
const nodes = (e) => (e && e.children ? e.children.flatMap((c) => [c, ...nodes(c)]) : []);
const cardMain = (profiles) => {
  const box = limitBox({ name: 'x', kind: 'claude', limit: { text: 'limit' }, canSwitch: true, profile: { name: 'max' } }, profiles, null);
  const b = nodes(box).find((e) => e.tag === 'button' && /primary/.test(e.className));
  return b ? textOf(b).replace(/^Continue on /, '') : null;
};
const near = { name: 'max', label: 'Max', kind: 'subscription', usage: { fiveHour: { pct: 97 } } };

test('Auto mode\'s order decides, as on the limit card: not the order the computer lists them', () => {
  const ps = [near, { name: 'team', label: 'Team', kind: 'subscription', autoPlace: 2 }, { name: 'pro', label: 'Pro', kind: 'subscription', autoPlace: 1 }];
  assert.match(accountsLine([{ machineLabel: 'Desk', profiles: ps }], false).text, /When it runs out, sessions can go on with Pro\.$/);
  assert.equal(cardMain(ps), 'Pro');
});

test('a provider that cannot run Claude Code is never the way on', () => {
  const ps = [near, { name: 'oc', label: 'OpenCode Zen', kind: 'subscription', tools: ['opencode'] }, { name: 'team', label: 'Team', kind: 'subscription' }];
  const line = accountsLine([{ machineLabel: 'Desk', profiles: ps }], false).text;
  assert.match(line, /When it runs out, sessions can go on with Team\.$/);
  assert.doesNotMatch(line, /OpenCode/);
  assert.equal(cardMain(ps), 'Team');
  const only = accountsLine([{ machineLabel: 'Desk', profiles: [near, ps[1]] }], false).text;
  assert.equal(only, 'Max is almost used up (97% of its 5-hour limit).', 'no promise of a way that cannot take the session');
});

test('a provider that is itself almost used up is no way on, on the line or on the card', () => {
  const ps = [near, { name: 'pro', label: 'Pro', kind: 'subscription', autoPlace: 1, usage: { fiveHour: { pct: 95 } } }, { name: 'team', label: 'Team', kind: 'subscription', autoPlace: 2 }];
  const line = accountsLine([{ machineLabel: 'Desk', profiles: ps }], false).text;
  assert.match(line, /^Max is almost used up .* Pro is almost used up .*When it runs out, sessions can go on with Team\.$/);
  assert.doesNotMatch(line, /go on with Pro/);
  assert.equal(cardMain(ps), 'Team');
});

test('two computers that would pick different ways: the line names none of them', () => {
  const max = sub('Max', 96);
  const pro = (place) => ({ name: 'pro', label: 'Pro', kind: 'subscription', autoPlace: place });
  const team = (place) => ({ name: 'team', label: 'Team', kind: 'subscription', autoPlace: place });
  const differ = accountsLine([
    { machine: null, machineLabel: 'Workstation', profiles: [max, pro(1), team(2)] },
    { machine: 'lap', machineLabel: 'Laptop', profiles: [max, pro(2), team(1)] },
  ], true).text;
  assert.equal(differ, 'Max is almost used up (96% of its 5-hour limit), on Workstation and Laptop. When it runs out, sessions can go on with another provider.');
  const same = accountsLine([
    { machine: null, machineLabel: 'Workstation', profiles: [max, pro(1), team(2)] },
    { machine: 'lap', machineLabel: 'Laptop', profiles: [max, pro(1)] },
  ], true).text;
  assert.match(same, /When it runs out, sessions can go on with Pro\.$/, 'each computer picks the same one: it is named');
});

test('outside Auto mode\'s order: a subscription before a gateway, as on the limit card', () => {
  const ps = [near, { name: 'gw', label: 'Gateway', kind: 'api', paid: false }, { name: 'team', label: 'Team', kind: 'subscription' }];
  assert.match(accountsLine([{ machineLabel: 'Desk', profiles: ps }], false).text, /go on with Team\.$/);
  assert.equal(cardMain(ps), 'Team');
});
