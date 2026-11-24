import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTS, CLASSES, ITEM_BYTES, KINDS, act, actCatalog, allowedActs, itemId, makeItem, publicItem, rank } from '../../src/operator/item.mjs';

const base = { kind: 'stuck', subject: 'session alpha', cls: 'stopped', facts: ['working for 25 min'], acts: ['open', 'stop'], why: 'no progress' };

test('the same kind and subject give the same id; another subject another id', () => {
  const a = makeItem(base);
  const b = makeItem({ ...base, facts: ['working for 40 min'], since: '2026-01-01T00:00:00Z' });
  assert.equal(a.id, b.id);
  assert.equal(a.id, itemId('stuck', 'session alpha'));
  assert.notEqual(a.id, makeItem({ ...base, subject: 'session beta' }).id);
  assert.notEqual(a.id, makeItem({ ...base, kind: 'asks' }).id);
  assert.match(a.id, /^stuck-[0-9a-f]{12}$/);
});

test('rev changes with what the item says, not with its time or how long ago', () => {
  const a = makeItem(base);
  assert.equal(a.rev, makeItem({ ...base, since: '2026-01-01T00:00:00Z' }).rev);
  for (const later of ['working for 40 min', 'working for 2 h 5 min', 'working for 3 days', 'working for under a minute']) {
    assert.equal(a.rev, makeItem({ ...base, facts: [later] }).rev, later);
  }
  assert.equal(makeItem({ ...base, facts: ['answers 530', 'checked at 13:59 UTC'] }).rev, makeItem({ ...base, facts: ['answers 530', 'checked at 14:07 UTC'] }).rev);
  assert.notEqual(a.rev, makeItem({ ...base, facts: ['waiting for 40 min'] }).rev);
  assert.notEqual(makeItem({ ...base, facts: ['answers 530'] }).rev, makeItem({ ...base, facts: ['answers 502'] }).rev);
  assert.notEqual(a.rev, makeItem({ ...base, recommended: 'stop' }).rev);
  const load = (n) => makeItem({ ...base, facts: [`load ${n}`], state: 'over' });
  assert.equal(load('6.4').rev, load('7.9').rev, 'with a state, moving figures do not count');
});

test('every item can be put off with "Not now" (the panel\'s act, not repeated in the item), and the recommended act is one of its acts', () => {
  const a = makeItem(base);
  assert.deepEqual(a.acts.map((x) => x.id), ['open', 'stop']);
  assert.deepEqual(allowedActs(a), ['open', 'stop', 'dismiss']);
  assert.deepEqual(makeItem({ ...base, acts: ['open', 'dismiss'] }).acts.map((x) => x.id), ['open']);
  assert.throws(() => makeItem({ ...base, acts: [] }), /at least one act/);
  assert.equal(a.recommended, 'open');
  assert.throws(() => makeItem({ ...base, recommended: 'push' }), /recommended act/);
  assert.throws(() => makeItem({ ...base, acts: ['format-disk'] }), /unknown act/);
});

test('unknown kinds and classes are refused', () => {
  assert.throws(() => makeItem({ ...base, kind: 'weather' }), /unknown kind/);
  assert.throws(() => makeItem({ ...base, cls: 'urgent' }), /unknown class/);
  assert.throws(() => makeItem({ ...base, subject: '  ' }), /subject/);
});

test('facts are at most 8 short lines, and long text is cut', () => {
  const a = makeItem({ ...base, facts: Array.from({ length: 12 }, (_, i) => `line ${i} is short`) });
  assert.equal(a.facts.length, 8);
  const b = makeItem({ ...base, facts: [`one ${'x'.repeat(300)}`], why: 'y'.repeat(500) });
  assert.ok(b.facts[0].length <= 100);
  assert.ok(b.why.length <= 160);
});

test('the effect and undo of each act are sent once per list, for the acts it holds and Not now', () => {
  const cat = actCatalog([makeItem(base)]);
  assert.deepEqual(Object.keys(cat).sort(), ['dismiss', 'open', 'stop']);
  assert.equal(cat.stop.undo, ACTS.stop.undo);
  assert.equal(cat.stop.label, 'End the session', 'the word of the session page');
  assert.equal(cat.stop.risk, 'stops');
  assert.equal(ACTS.end.risk, 'stops', 'ending a process ends what runs in it, with nothing to undo');
  assert.equal('undo' in cat.open, false);
});

test('an "open" act leads only to a page address', () => {
  assert.equal(act('open', { href: '#/s/alpha' }).href, '#/s/alpha');
  assert.deepEqual(act('stop'), { id: 'stop' });
  assert.deepEqual(act('open', { label: 'Open the session' }), { id: 'open', label: 'Open the session' });
  assert.throws(() => act('open', { href: 'https://example.com/?token=x' }), /page address/);
  assert.throws(() => act('open', { href: 'javascript:alert(1)' }), /page address/);
});

test('the target stays on the server', () => {
  const a = makeItem({ ...base, target: { session: 'alpha', secret: 'never' } });
  assert.equal(a.target.session, 'alpha');
  const p = publicItem(a);
  assert.equal(p.target, undefined);
  assert.doesNotMatch(JSON.stringify(p), /never/);
});

test('ranking: harm, then stopped work, then what waits, then the machine, then information; oldest first', () => {
  const mk = (kind, cls, subject, since) => makeItem({ kind, cls, subject, since, acts: ['open'] });
  const list = rank([
    mk('automation', 'info', 'brain', '2026-01-01T00:00:00Z'),
    mk('machine', 'machine', 'tmp', '2026-01-01T00:00:00Z'),
    mk('asks', 'waits', 'beta', '2026-01-01T00:10:00Z'),
    mk('asks', 'waits', 'gamma', '2026-01-01T00:05:00Z'),
    mk('limit', 'stopped', 'alpha', '2026-01-02T00:00:00Z'),
    mk('repo', 'harm', 'example/shop', '2026-01-03T00:00:00Z'),
  ]);
  assert.deepEqual(list.map((i) => i.subject), ['example/shop', 'alpha', 'gamma', 'beta', 'tmp', 'brain']);
});

test('the catalogs are closed lists', () => {
  assert.equal(KINDS.length, 12);
  assert.deepEqual(CLASSES, ['harm', 'stopped', 'waits', 'machine', 'info']);
  for (const [id, a] of Object.entries(ACTS)) {
    assert.ok(a.label && a.effect, id);
    assert.ok(['none', 'low', 'stops', 'others'].includes(a.risk), id);
  }
  assert.ok(Object.isFrozen(ACTS));
});

test('an item never weighs more than 700 bytes: the last facts go first, then the text gets shorter', () => {
  const big = makeItem({ ...base, subject: `session ${'s'.repeat(200)}`, acts: ['switch', 'open', 'stop'], facts: Array.from({ length: 8 }, (_, i) => `${i} ${'f'.repeat(200)}`), why: 'w'.repeat(400) });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= ITEM_BYTES, `${Buffer.byteLength(JSON.stringify(big))} bytes`);
  assert.ok(big.facts.length >= 3, `${big.facts.length} facts kept`);
  assert.match(big.facts[0], /^0 /);
  const small = makeItem(base);
  assert.deepEqual(small.facts, base.facts, 'a small item is left as it is');
});
