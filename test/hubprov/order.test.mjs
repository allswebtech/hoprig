// Auto mode on a linked computer: its own order first, then the main computer's providers in the main computer's order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { madeUpKey } from './helpers.mjs';

const box = sandbox('hubprov-order');
test.after(() => box.cleanup());
const { writeProfile, listProfiles } = await import('../../src/profiles.mjs');
const { setAutoSwitch, usableOrder, nextProfile, markLimited } = await import('../../src/autoswitch.mjs');
const { saveRows } = await import('../../src/hubprov/rows.mjs');
const { buildList } = await import('../../src/hubprov/list.mjs');

const row = (name, place, extra = {}) => ({ name: `hub-${name}`, hubRow: name, label: name, kind: 'api', paid: false, signin: false, place, limited: null, hubLabel: 'Hub A', offline: false, ...extra });

test('own order first, then the rows of the main computer\'s Auto order, in that order; a row outside it takes no part', () => {
  writeProfile('mine', { label: 'Mine', env: { ANTHROPIC_API_KEY: madeUpKey('k'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  saveRows({ port: 1, rows: [row('late', 1), row('first', 0), row('outside', null)] });
  assert.deepEqual(listProfiles().map((p) => p.name), ['mine', 'hub-late', 'hub-first', 'hub-outside'], 'the one list: own, then the rows');
  setAutoSwitch({ enabled: true, order: ['mine'], payPerUse: true });
  assert.deepEqual(usableOrder(), ['mine', 'hub-first', 'hub-late']);
  markLimited('mine', { until: Date.now() + 60_000 });
  assert.equal(nextProfile('mine'), 'hub-first', 'at its own limit, Auto goes on to the main computer\'s first');
  markLimited('hub-first', { until: Date.now() + 60_000 });
  assert.equal(nextProfile('mine'), 'hub-late', 'a row at its limit is skipped');
});

test('the main computer sends its Auto place with each provider', () => {
  const profiles = [{ name: 'a', label: 'A', kind: 'api', paid: false, env: { ANTHROPIC_API_KEY: madeUpKey('k') }, tools: [], models: '' }, { name: 'b', label: 'B', kind: 'api', paid: false, env: { ANTHROPIC_API_KEY: madeUpKey('k') }, tools: [], models: '' }];
  const list = buildList({ profiles, limited: {}, share: true, keep: [], order: ['b'] });
  assert.deepEqual(list.providers.map((p) => [p.name, p.place]), [['a', null], ['b', 0]]);
});
