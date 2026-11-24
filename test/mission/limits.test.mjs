// The owner's limits before every start (src/mission/limits.mjs) and his settings (settings.mjs), checked alone: the
// switches, working hours, sessions at once, this computer's load and memory, the caps, and the providers' order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_RUN_USD, budgetFor, inHours, overloaded, providerOrder, spentOn, whyNot } from '../../src/mission/limits.mjs';
import { cleanPatch, missionSettings, worksOn } from '../../src/mission/settings.mjs';

const ON = missionSettings({ missions: { on: true, projects: { shop: { on: true } }, capUsd: 1, providers: ['key'], atOnce: 2 } });
const free = { s: ON, project: 'shop', running: 0, slots: 4, clock: '10:00', spent: { usd: 0, tokens: 0, unknown: 0 }, machine: null };

test('off by default, twice: nothing in the config is "off", and both switches are needed', () => {
  const s = missionSettings({});
  assert.equal(s.on, false);
  assert.deepEqual(s.projects, {});
  assert.equal(s.capUsd, 0);
  assert.deepEqual(s.providers, []);
  assert.equal(worksOn(s, 'shop'), false);
  assert.equal(worksOn({ ...ON, on: false }, 'shop'), false);
  assert.equal(worksOn({ ...ON, projects: { shop: { on: false } } }, 'shop'), false);
  assert.equal(worksOn(ON, 'shop'), true);
  assert.equal(worksOn(missionSettings({ missions: { on: 'yes', projects: { shop: { on: 1 } } } }), 'shop'), false, 'only true is on');
  assert.equal(worksOn(missionSettings({ missions: { on: true, projects: { shop: {} } } }), 'shop'), false, 'a project is off until its own switch is on');
  assert.equal(worksOn(missionSettings({ missions: { on: true, projects: { shop: { on: 'true' } } } }), 'shop'), false);
});

test('every limit says why nothing starts, in order', () => {
  assert.equal(whyNot(free), null);
  assert.match(whyNot({ ...free, s: { ...ON, on: false } }), /^Tia OFF/);
  assert.match(whyNot({ ...free, project: 'blog' }), /does not work on blog/);
  assert.match(whyNot({ ...free, s: { ...ON, hours: { from: '09:00', to: '17:00' } }, clock: '17:30' }), /outside your working hours/);
  assert.match(whyNot({ ...free, running: 2 }), /at most 2 at once/);
  assert.match(whyNot({ ...free, running: 1, slots: 1 }), /at most 1 at once/, 'never more than this computer\'s slots');
  assert.match(whyNot({ ...free, machine: { cpus: 4, load1: 7, memTotal: 100, memAvailable: 50 } }), /overloaded/);
  assert.match(whyNot({ ...free, machine: { cpus: 4, load1: 1, memTotal: 100, memAvailable: 5 } }), /low on memory/);
  assert.match(whyNot({ ...free, s: { ...ON, capUsd: 0 } }), /no spend cap is set/);
  assert.match(whyNot({ ...free, spent: { usd: 1, tokens: 0, unknown: 0 } }), /spend cap of today is reached \(\$1\.00 of \$1\.00\)/);
  assert.match(whyNot({ ...free, s: { ...ON, capTokens: 500 }, spent: { usd: 0, tokens: 500, unknown: 0 } }), /token cap/);
  assert.equal(overloaded({ cpus: 4, load1: 6, memTotal: 100, memAvailable: 50 }), null, '1.5 per CPU is not above it');
  assert.equal(inHours({ from: '22:00', to: '06:00' }, '23:30'), true, 'across midnight');
  assert.equal(inHours({ from: '22:00', to: '06:00' }, '12:00'), false);
});

test('the spend of a day is the sum of its runs\' own cost lines; tokens only where no cost was reported', () => {
  const r = (day, cost, tokens) => ({ day, cost, tokens });
  const m = [{ tasks: [{ runs: [r('2026-11-19', 0.2, 100), r('2026-11-19', null, 300), r('2026-11-19', null, null), r('2026-11-18', 5, 1)] }] }];
  assert.deepEqual(spentOn(m, '2026-11-19'), { usd: 0.2, tokens: 300, unknown: 1 });
  // a run that reported nothing (stopped at its time limit) counts at the budget it was allowed
  const stopped = [{ tasks: [{ runs: [{ day: '2026-11-19', cost: null, tokens: null, budget: 0.15 }, { day: '2026-11-19', cost: 0.05, tokens: 10, budget: 0.15 }] }] }];
  assert.deepEqual(spentOn(stopped, '2026-11-19'), { usd: 0.2, tokens: 0, unknown: 0 });
});

test('providers: only the allowed ones, in his order, gateways and keys before a subscription', () => {
  const known = [{ name: 'sub', kind: 'subscription' }, { name: 'gw', kind: 'api' }, { name: 'key', kind: 'api' }, { name: 'auto', kind: 'auto' }, { name: 'other', kind: 'api' }];
  const s = { ...ON, providers: ['sub', 'key', 'gw', 'auto', 'gone'] };
  assert.deepEqual(providerOrder(s, known), ['key', 'gw', 'sub'], 'a subscription after the others, Auto mode and an unknown name never');
  assert.deepEqual(providerOrder({ ...ON, providers: ['gw'] }, known), ['gw'], 'one not in his order is never used');
  assert.deepEqual(providerOrder(s, known, { silent: ['key'], skip: ['gw'] }), ['sub'], 'one that reports nothing, or is at its limit, is passed over');
  assert.deepEqual(providerOrder(s, known, { tokensOnly: ['key'] }), ['gw', 'sub'], 'tokens only: not without a token cap');
  assert.deepEqual(providerOrder({ ...s, capTokens: 1000 }, known, { tokensOnly: ['key'] }), ['key', 'gw', 'sub']);
});

test('a change of the settings is checked strictly', () => {
  const cur = missionSettings({});
  const c = { projects: ['shop'], providers: ['key'] };
  assert.throws(() => cleanPatch({ sudo: true }, cur, c), /not a setting/);
  assert.throws(() => cleanPatch({ on: 'yes' }, cur, c), /true or false/);
  assert.throws(() => cleanPatch({ projects: { blog: { on: true } } }, cur, c), /not a project/);
  assert.throws(() => cleanPatch({ projects: { shop: { on: true, test: ['npm', 'test\n'] } } }, cur, c), /test command/);
  assert.throws(() => cleanPatch({ providers: ['nobody'] }, cur, c), /providers/);
  assert.throws(() => cleanPatch({ atOnce: 9 }, cur, c), /1 to 4/);
  assert.throws(() => cleanPatch({ selfAccept: ['code'] }, cur, c), /only docs and tests/);
  assert.throws(() => cleanPatch({ hours: { from: '9', to: '17:00' } }, cur, c), /working hours/);
  const next = cleanPatch({ on: true, projects: { shop: { on: true, test: ['npm', 'test'] } }, capUsd: 2.456, providers: ['key'] }, cur, c);
  assert.deepEqual([next.on, next.projects.shop, next.capUsd, next.providers], [true, { on: true, test: ['npm', 'test'] }, 2.46, ['key']]);
});

test('a session\'s budget: what is left of the cap after the spend and what runs holds, shared with the free places', () => {
  assert.deepEqual(budgetFor({ capUsd: 0.3, spentUsd: 0, held: 0, most: 2, running: 0 }), { left: 0.3, budget: 0.15 });
  assert.deepEqual(budgetFor({ capUsd: 0.3, spentUsd: 0, held: 0.15, most: 2, running: 1 }), { left: 0.15, budget: 0.15 }, 'the second gets what the first does not hold');
  assert.deepEqual(budgetFor({ capUsd: 1, spentUsd: 0.71, held: 0, most: 1, running: 0 }), { left: 0.29, budget: 0.29 }, 'whole cents, no float slip');
  assert.equal(budgetFor({ capUsd: 0.3, spentUsd: 0.2, held: 0.06, most: 2, running: 1 }).budget, null, `under $${MIN_RUN_USD} left: nothing starts`);
  assert.equal(budgetFor({ capUsd: 0.3, spentUsd: 0.31, held: 0, most: 1, running: 0 }).budget, null);
  assert.equal(budgetFor({ capUsd: 3, spentUsd: 0, held: 0, most: 1, running: 0, toCome: 6 }).budget, 0.5, 'shared over the sessions still to come');
  assert.equal(budgetFor({ capUsd: 3, spentUsd: 0, held: 0, most: 4, running: 0, toCome: 2 }).budget, 0.75, 'or over the free places, when more');
  // any order of starts: what all of them hold together never passes the cap
  for (const most of [1, 2, 3, 4]) {
    let held = 0;
    for (let running = 0; running < most; running++) {
      const b = budgetFor({ capUsd: 1, spentUsd: 0.37, held, most, running }).budget;
      if (b !== null) held = Math.round((held + b) * 100) / 100;
    }
    assert.ok(held <= 0.63 + 1e-9, `${most} at once hold $${held}`);
  }
});
