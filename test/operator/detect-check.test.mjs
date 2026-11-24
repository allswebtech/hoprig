// The items once the provider check and the map exist: a limit says "wait until" only for a time that was named; the
// model-name item's second act is "Check this provider" and its reason is the mend line of the last check; a session
// Hoprig did not start makes the same items, opened at Providers and never ended from here. Made-up names only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLimit } from '../../src/operator/detect/limit.mjs';
import { detectProviderStop } from '../../src/operator/detect/providerstop.mjs';
import { namedReset } from '../../src/operator/sources.mjs';

const NOW = Date.parse('2026-11-19T05:00:00Z');
const at = (m) => new Date(NOW - m * 60_000).toISOString();
const limited = (resetsAt) => ({ sessions: [{ name: 'shop', provider: 'relay-a', state: 'working', limit: { at: at(10), text: 'API Error: 429', resetsAt }, agents: [], canSwitch: true, nextProvider: 'plan-b' }] });

test('a limit says "wait until" a named time, and nothing when none was named', () => {
  const [named] = detectLimit(limited(new Date(NOW + 2 * 3600_000).toISOString()), { now: NOW });
  assert.match(named.why, /plan-b can go on with it now, or wait until 07:00 UTC\.$/);
  const [none] = detectLimit(limited(null), { now: NOW });
  assert.doesNotMatch(none.why + none.facts.join('|'), /wait until|resets/);
  const alone = { sessions: [{ ...limited(new Date(NOW + 3600_000).toISOString()).sessions[0], canSwitch: false }] };
  assert.equal(detectLimit(alone, { now: NOW })[0].why, 'No other provider can take it over here; wait until 06:00 UTC.');
});

test('a limit item names the providers as the pages do: their labels, the short name only without one', () => {
  const s = { ...limited(null).sessions[0], provider: 'max', providerLabel: 'Claude Max', nextProvider: 'api', nextProviderLabel: 'API (pay as you go)' };
  const [it] = detectLimit({ sessions: [s] }, { now: NOW });
  assert.ok(it.facts.includes('provider Claude Max'), it.facts.join('|'));
  assert.ok(it.facts.includes('next provider in the order: API (pay as you go)'), it.facts.join('|'));
  assert.equal(it.why, 'The work waits for the limit; API (pay as you go) can go on with it now.');
  assert.doesNotMatch(it.facts.join('|') + it.why, /\bmax\b|\bapi\b/);
  const [bare] = detectLimit(limited(null), { now: NOW });
  assert.ok(bare.facts.includes('provider relay-a') && /plan-b can go on/.test(bare.why), 'no label: the name');
});

test('the time comes from the tool\'s line or a full window the provider reported, never guessed', () => {
  assert.ok(namedReset("You've hit your 5-hour limit · resets 7am (UTC)", null, NOW).startsWith('2026-11-19T07:00'));
  const full = { fiveHour: { pct: 100, resetsAt: NOW + 3600_000 } };
  assert.equal(namedReset('API Error: 429 rate limit', full, NOW), new Date(NOW + 3600_000).toISOString());
  assert.equal(namedReset('API Error: 429 rate limit', { fiveHour: { pct: 60, resetsAt: NOW + 3600_000 } }, NOW), null, 'a window that is not full names no end');
  assert.equal(namedReset('API Error: 429 rate limit', null, NOW), null);
});

test('"resets 7am" is read against when the limit was hit, and a time that has passed is no time', () => {
  const line = "You've hit your session limit · resets 7am (UTC)";
  const hit = '2026-11-19T06:50:00Z';
  assert.equal(namedReset(line, null, Date.parse('2026-11-19T06:55:00Z'), hit), '2026-11-19T07:00:00.000Z');
  // A look after 07:00 with the limit still on the record: it reset already, no "wait until" a day later.
  assert.equal(namedReset(line, null, Date.parse('2026-11-19T07:10:00Z'), hit), null);
  // A line written the evening before, read the next morning after the reset.
  assert.equal(namedReset("You've hit your limit · resets 7am (UTC)", null, Date.parse('2026-11-19T08:00:00Z'), '2026-11-18T17:00:00Z'), null);
  assert.equal(namedReset("You've hit your limit · resets 7am (UTC)", null, Date.parse('2026-11-18T23:00:00Z'), '2026-11-18T17:00:00Z'), '2026-11-19T07:00:00.000Z');
});

const refused = (providers) => ({
  providers,
  sessions: [{ name: 'shop', provider: 'relay-a', state: 'working', stop: null, agents: [{ id: 'a1', label: 'Check the shop page', stop: { at: at(5), reason: 'model', text: "API Error: 400 Ambiguous model 'claude-opus-5'" } }] }],
});

test('the model-name item offers "Check this provider" on its page and names the mend of the last check', () => {
  const [it] = detectProviderStop(refused([{ name: 'relay-a', checkable: true, check: { at: at(60), gaps: [{ name: 'claude-opus-5', mend: 'Add a combo named "claude-opus-5" at the gateway, or set MODELS=claude-opus-5=claude-opus-5-5' }] } }]), { now: NOW });
  assert.deepEqual(it.acts.map((a) => [a.label, a.href]), [['Open the session', '#/s/shop'], ['Check this provider', '#/providers/relay-a']]);
  assert.match(it.why, /^Add a combo named "claude-opus-5" at the gateway/);
  // Not checked yet: the reason says what the check finds.
  const [fresh] = detectProviderStop(refused([{ name: 'relay-a', checkable: true, check: null }]), { now: NOW });
  assert.equal(fresh.acts[1].label, 'Check this provider');
  assert.match(fresh.why, /^Check this provider/);
  // A provider that cannot be checked (a sign-in) keeps the earlier act and words.
  const [sign] = detectProviderStop(refused([{ name: 'relay-a', checkable: false, check: null }]), { now: NOW });
  assert.equal(sign.acts[1].label, 'See this provider');
});

test('the mend is the gap of the very name that stopped, never of a name that only contains it or of another', () => {
  const gaps = [{ name: 'claude-opus-5', mend: 'Add a combo named "claude-opus-5" at the gateway' }];
  const board = (text) => ({ ...refused([{ name: 'relay-a', checkable: true, check: { at: at(60), gaps } }]), sessions: [{ name: 'shop', provider: 'relay-a', state: 'working', stop: { at: at(1), reason: 'model', text }, agents: [] }] });
  for (const text of ["API Error: 400 Ambiguous model 'claude-opus-5-5'", "API Error: 404 There's an issue with the selected model (relay-small)", 'API Error: 400 no such model here']) {
    const [it] = detectProviderStop(board(text), { now: NOW });
    assert.doesNotMatch(it.why, /claude-opus-5"/, text);
    assert.match(it.why, /^Check this provider/, text);
  }
  const [hit] = detectProviderStop(board("API Error: 400 Ambiguous model 'claude-opus-5'"), { now: NOW });
  assert.match(hit.why, /^Add a combo named "claude-opus-5"/);
});

test('a session Hoprig did not start makes the same items, opened at Providers and never ended from here', () => {
  const outside = { name: '8cbd5db6', outside: true, folder: 'shop', provider: null, state: 'unknown', stop: null, agents: refused([]).sessions[0].agents, limit: null };
  const [it] = detectProviderStop({ sessions: [outside] }, { now: NOW });
  assert.equal(it.subject, 'session 8cbd5db6 in shop, not started by Hoprig');
  assert.deepEqual(it.acts[0], { id: 'open', label: 'Open Providers', href: '#/providers' });
  assert.ok(!it.facts.some((f) => f.startsWith('provider ')), it.facts.join('|'));
  assert.equal(it.why, 'Which provider ran it is not known here: check the providers it may use.');
  // The one checked provider whose last check refused that very name: its mend, and its page.
  const gapOf = (name) => ({ name, checkable: true, check: { at: at(30), gaps: [{ name: 'claude-opus-5', mend: `Add a combo named "claude-opus-5" at the gateway of ${name}` }] } });
  const [one] = detectProviderStop({ sessions: [outside], providers: [gapOf('relay-a'), { name: 'relay-b', checkable: true, check: { at: at(30), gaps: [] } }] }, { now: NOW });
  assert.equal(one.why, 'Add a combo named "claude-opus-5" at the gateway of relay-a.');
  assert.deepEqual(one.acts.map((a) => [a.label, a.href]), [['Check this provider', '#/providers/relay-a']]);
  // Two providers refused it: which one ran it is not known.
  const [two] = detectProviderStop({ sessions: [outside], providers: [gapOf('relay-a'), gapOf('relay-b')] }, { now: NOW });
  assert.match(two.why, /^Which provider ran it is not known here/);
  assert.deepEqual(two.acts.map((a) => a.href), ['#/providers']);
  const [lim] = detectLimit({ sessions: [{ ...outside, agents: [], limit: { at: at(3), text: 'API Error: 429', resetsAt: null } }] }, { now: NOW });
  assert.deepEqual(lim.acts.map((a) => a.id), ['open']);
  assert.ok(!lim.facts.some((f) => f.startsWith('provider ')), lim.facts.join('|'));
});
