// The Providers list as data: the state words (a refused sign-in is not a limit; a limit names its window and when it
// is back), the groups and their order, the summary line, the two bars and the one button of a row.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { profileState, limitWindow } = await import('../../web/lib.js');
const W = await import('../../web/providerwords.js');
const H = 3600_000;
const sub = (o) => ({ kind: 'subscription', signedIn: true, ...o });

test('a refused sign-in says so, and is not a limit; signed out and never signed in say so', () => {
  const at = new Date(2026, 10, 28, 3, 10).getTime();
  const refused = sub({ signedIn: false, signinRefused: { at }, limited: { until: at + 600_000, exact: true, reason: 'auth' } });
  assert.equal(profileState(refused).key, 'signin');
  assert.match(profileState(refused).text, /^Sign-in refused at .*03:10$/);
  // the router's mark alone (a server that kept no refusal yet): still not a limit
  assert.equal(profileState(sub({ limited: { until: Date.now() + 600_000, exact: true, reason: 'auth' } })).key, 'signin');
  assert.deepEqual(profileState(sub({ signedIn: false, signedOut: true })), { key: 'signin', text: 'Signed out' });
  assert.deepEqual(profileState({ kind: 'login', signedIn: false }), { key: 'signin', text: 'Not signed in' });
});

test('a limit names its window and when it is back; an estimate says about; out of credit says so', () => {
  const now = Date.now();
  const five = sub({ limited: { until: now + 80 * 60_000, exact: true, reason: 'rate_limit' }, usage: { fiveHour: { pct: 100, resetsAt: now + 80 * 60_000 }, week: { pct: 52, resetsAt: now + 3 * 24 * H } } });
  assert.equal(limitWindow(five), 'fiveHour');
  assert.match(profileState(five).text, /^5-hour limit · back in 1 h 2?\d min$|^5-hour limit · back in 1 h 20 min$/);
  const week = sub({ limited: { until: now + 3 * 24 * H, exact: true, reason: 'rate_limit' }, usage: { fiveHour: { pct: 0, resetsAt: now + 3 * H }, week: { pct: 100, resetsAt: now + 3 * 24 * H } } });
  assert.match(profileState(week).text, /^Weekly limit · back /);
  const unknown = sub({ limited: { until: now + 40 * 60_000, exact: true, reason: 'limit' } });
  assert.match(profileState(unknown).text, /^At its limit · back in \d+ min$/);
  const est = sub({ limited: { until: now + 5 * H, exact: false, reason: 'limit' } });
  assert.match(profileState(est).text, /^At its limit · back about \d\d:\d\d$|^At its limit · back about \w+ \d\d:\d\d$/);
  assert.match(profileState(sub({ limited: { until: now + H, exact: true, reason: 'billing_error' } })).text, /^Out of credit · try again /);
  assert.deepEqual(profileState(sub({ inUse: 2 })), { key: 'inuse', text: 'In use · 2 sessions' });
  assert.deepEqual(profileState(sub({})), { key: 'free', text: 'Available' });
});

test('groups: needs a sign-in first, then can work, then at a limit soonest back first, then cannot be used', () => {
  const now = Date.now();
  const list = [
    sub({ name: 'a', limited: { until: now + 5 * H, exact: true, reason: 'rate_limit' } }),
    sub({ name: 'b' }),
    sub({ name: 'c', signedOut: true, signedIn: false }),
    sub({ name: 'd', limited: { until: now + H, exact: true, reason: 'rate_limit' } }),
    { kind: 'api', name: 'e', unusable: true },
    sub({ name: 'f', limited: { until: now + 600_000, exact: true, reason: 'auth' } }),
    { kind: 'api', name: 'g' },
  ];
  const groups = W.groupRows(list);
  assert.deepEqual(groups.map((g) => g.key), ['signin', 'work', 'limit', 'cannot']);
  assert.deepEqual(groups.map((g) => g.rows.map((r) => r.name)), [['c', 'f'], ['b', 'g'], ['d', 'a'], ['e']]);
  assert.equal(W.summaryLine(groups), '2 can work · 2 at a limit · 2 to sign in');
  assert.equal(W.summaryLine(W.groupRows([sub({ name: 'x' })])), '1 can work', 'a group with none is left out');
  assert.equal(W.summaryLine([]), '');
});

test('bars show the windows that are known, with back from 80%; the one button follows the state', () => {
  const now = Date.now();
  const a = sub({ usage: { fiveHour: { pct: 41, resetsAt: now + H }, week: { pct: 88, resetsAt: now + 50 * H } } });
  const bars = W.barsOf(a);
  assert.deepEqual(bars.map((b) => [b.label, b.pct, !!b.back]), [['5-hour', 41, false], ['Week', 88, true]]);
  assert.deepEqual(W.barsOf(sub({ usage: { week: { pct: 10, resetsAt: null } } })).map((b) => b.label), ['Week'], 'an unknown window is not drawn');
  assert.deepEqual(W.barsOf(sub({})), []);
  assert.deepEqual(W.rowButton(sub({ signedIn: false, signinRefused: { at: 1 } }), true, false), { kind: 'signin', label: 'Sign in again' });
  assert.deepEqual(W.rowButton(sub({ signedIn: false, signedOut: true }), true, false), { kind: 'signin', label: 'Sign in' });
  assert.deepEqual(W.rowButton(sub({ signedIn: false, hub: true }), true, false), { kind: 'signin', label: 'Sign in here' });
  const limited = { kind: 'login', limited: { until: now + H, exact: true, reason: 'rate_limit' } };
  assert.deepEqual(W.rowButton(limited, true, true), { kind: 'another', label: 'Sign in with another account' });
  assert.equal(W.rowButton(sub({}), true, false), null, 'every other row has none');
  assert.equal(W.rowButton(sub({ signedIn: false }), false, false), null, 'not on another computer page');
});

test('the page: the row has no Works with line for a Claude-only provider; Refresh and Read now answer in place', () => {
  const src = fs.readFileSync('web/accounts.js', 'utf8');
  assert.match(src, /worksWith\(a\) && !servesClaude\(a\) \? h\('span\.row-sub\.acct-works|worksWith\(a\) && !servesClaude\(a\) \? h\('span\.row-sub\.acct-tools'/);
  assert.match(src, /api\(A\('\/limits\/read'\), \{\}\)/, 'Refresh reads every account');
  assert.match(src, /api\(A\('\/limits\/read'\), \{ name: a\.name \}\)/, 'Read now reads one');
  assert.match(src, /reading \? 'Reading…' : 'Refresh'/, 'busy at once');
  assert.match(src, /clearInterval\(timer\)/, 'the minute timer ends when the page is left');
  assert.match(src, /label: 'Sign in with another account'/);
  assert.match(fs.readFileSync('web/claudeaccount.js', 'utf8'), /The key itself is not cancelled at Claude\./);
});
