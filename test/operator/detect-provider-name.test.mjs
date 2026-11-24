// Every item that names a provider names it as the Providers page does: its label, the short name only where it has
// none. Made-up providers.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as util from '../../src/operator/detect/util.mjs';
import { detectAsks } from '../../src/operator/detect/asks.mjs';
import { detectStuck } from '../../src/operator/detect/stuck.mjs';
import { detectEnded } from '../../src/operator/detect/ended.mjs';
import { detectProvider } from '../../src/operator/detect/provider.mjs';
import { detectProviderStop } from '../../src/operator/detect/providerstop.mjs';
import { detectLimit } from '../../src/operator/detect/limit.mjs';
import { decisionFacts } from '../../src/operator/decide-prompt.mjs';
import { itemId, makeItem } from '../../src/operator/item.mjs';
import { attention } from '../../src/operator/attention.mjs';
import { stopOf } from '../../src/operator/sources.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

const LABEL = 'Shop Team Plan';
const labelled = (over) => session({ provider: 'team', providerLabel: LABEL, ...over });
const has = (it, fact) => assert.ok(it.facts.includes(fact), it.facts.join('|'));

test('the helper: the label, the short name without one, a long label cut to 40 characters', () => {
  const { providerName } = util;
  assert.equal(typeof providerName, 'function');
  assert.equal(providerName('team', LABEL), LABEL);
  assert.equal(providerName('team', null), 'team');
  assert.equal(providerName('team', ''), 'team');
  assert.equal(providerName(null, null), 'unknown');
  const long = providerName('team', 'A'.repeat(60));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'), long);
  // Auto mode, as the Providers page names it (its virtual profile's own label is only "Auto").
  assert.equal(providerName('auto', 'Auto'), 'Auto mode');
  assert.equal(providerName('auto', null), 'Auto mode');
});

test('a session that asks names its provider by its label', () => {
  const [it] = detectAsks({ sessions: [labelled({ state: 'attention', asks: ['main'], askType: 'permission', askAt: ago(3) })] }, { now: NOW });
  has(it, `provider ${LABEL}`);
  const [bare] = detectAsks({ sessions: [session({ provider: 'team', state: 'attention', asks: ['main'], askAt: ago(3) })] }, { now: NOW });
  has(bare, 'provider team');
});

test('a stuck session names its provider by its label', () => {
  const [it] = detectStuck({ sessions: [labelled({ progressAt: ago(30) })] }, { now: NOW });
  has(it, `provider ${LABEL}`);
});

test('an ended session names its provider by its label', () => {
  const [it] = detectEnded({ sessions: [labelled({ state: 'ended', statusAt: ago(5) })] }, { now: NOW });
  has(it, `provider ${LABEL}`);
});

test('a provider near its limit is called by its label; the act still finds it by its name', () => {
  const p = { name: 'team', label: LABEL, signedIn: true, usage: { fiveHour: { pct: 90, resetsAt: null }, week: null, at: ago(1) } };
  const [it] = detectProvider({ providers: [p] }, { now: NOW });
  assert.equal(it.subject, `provider ${LABEL}`);
  assert.deepEqual(it.target, { provider: 'team' });
  const [bare] = detectProvider({ providers: [{ ...p, label: null }] }, { now: NOW });
  assert.equal(bare.subject, 'provider team');
});

test('a provider stop names the provider by its label', () => {
  const stop = stopOf({ at: NOW - 60_000, error: 'server_error', text: 'API Error: 500' });
  const [it] = detectProviderStop({ sessions: [labelled({ state: 'attention', stop })] }, { now: NOW });
  has(it, `provider ${LABEL}`);
});

test('a limit item cuts a long label as the others do', () => {
  const [it] = detectLimit({ sessions: [labelled({ providerLabel: 'B'.repeat(60), limit: { at: ago(5), text: 'limit', resetsAt: null } })] }, { now: NOW });
  has(it, `provider ${'B'.repeat(39)}…`);
});

test('a decision leaves out the provider line also when the label has spaces', () => {
  const it = makeItem({ kind: 'stuck', cls: 'stopped', subject: 'session alpha', facts: ['quiet', `provider ${LABEL}`], acts: ['open'], target: { session: 'alpha' } });
  assert.deepEqual(decisionFacts(it), ['quiet']);
  const lim = makeItem({ kind: 'limit', cls: 'stopped', subject: 'session alpha', facts: [`provider ${LABEL}`], acts: ['open'], target: { session: 'alpha' } });
  assert.deepEqual(decisionFacts(lim), [`provider ${LABEL}`], 'at a limit the provider is what is moved from');
});

test('a provider card keeps the id it had before it named the label: a "Not now" given then still holds', () => {
  const p = { name: 'team', label: LABEL, signedIn: true, usage: { fiveHour: { pct: 90, resetsAt: '2026-03-10T16:00:00Z' }, at: ago(2) } };
  const [it] = detectProvider({ providers: [p] }, { now: NOW });
  assert.equal(it.subject, `provider ${LABEL}`, 'the card reads the label');
  const earlier = itemId('provider', 'provider team'); // the id the card had while its subject was the short name
  assert.equal(it.id, earlier);
  const [renamed] = detectProvider({ providers: [{ ...p, label: 'Shop Team Plan (new name)' }] }, { now: NOW });
  assert.equal(renamed.id, earlier, 'a new label keeps the id');
  const board = { at: new Date(NOW).toISOString(), providers: [p] };
  const put = attention(board, { now: NOW, dismissed: new Map([[earlier, it.rev]]) });
  assert.equal(put.hidden, 1, 'put off under the earlier id, it stays put off');
  assert.ok(!put.items.some((i) => i.kind === 'provider'), put.items.map((i) => i.subject).join('|'));
});
