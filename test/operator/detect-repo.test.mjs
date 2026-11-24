import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRepo } from '../../src/operator/detect/repo.mjs';
import { ACTS } from '../../src/operator/item.mjs';
import { NOW, ago } from './fixtures/cases.mjs';

const repo = (over) => ({ name: 'example/shop', path: 'shop/code/shop', project: 'shop', branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: 0, fetchedAt: ago(30), ...over });

test('a clone only behind its upstream: bring it up to date, said as of the last fetch', () => {
  const [it] = detectRepo({ repos: [repo({ behind: 3 })] }, { now: NOW });
  assert.equal(it.recommended, 'sync');
  assert.equal(it.class, 'info');
  assert.deepEqual(it.facts, ['branch main → origin/main', '3 newer commits on the git server, not here yet', 'as of the last fetch at 13:30 UTC']);
  assert.deepEqual(it.target, { path: 'shop/code/shop', branch: 'main' });
});

test('only ahead: push, with the risk that others see it; work in progress ranks as information', () => {
  const [it] = detectRepo({ repos: [repo({ ahead: 1 })] }, { now: NOW });
  assert.equal(it.recommended, 'push');
  assert.ok(it.facts.includes('1 commit here not yet sent to the git server'), it.facts.join('|'));
  assert.equal(it.class, 'info');
  assert.ok(it.acts.some((a) => a.id === 'push'));
  assert.equal(ACTS.push.risk, 'others');
});

test('behind and ahead, or with changes: no sync and no push, only open the project', () => {
  for (const over of [{ behind: 2, ahead: 1 }, { behind: 2, dirty: 4 }, { ahead: 1, dirty: 1, behind: 1 }]) {
    const [it] = detectRepo({ repos: [repo(over)] }, { now: NOW });
    assert.deepEqual(it.acts.map((a) => a.id), ['open'], JSON.stringify(over));
    assert.equal(it.acts[0].href, '#/workspace/project/shop');
  }
});

test('a branch without an upstream exists only here', () => {
  const [it] = detectRepo({ repos: [repo({ branch: 'try-x', upstream: null, fetchedAt: null })] }, { now: NOW });
  assert.equal(it.class, 'info');
  assert.ok(it.facts.includes('the branch is not on the git server: it exists only here'));
  assert.ok(it.facts.includes('never fetched here'));
});

test('in step, or no source: nothing', () => {
  assert.deepEqual(detectRepo({ repos: [repo({})] }, { now: NOW }), []);
  assert.deepEqual(detectRepo({ repos: null }, { now: NOW }), []);
});

test('a fetch that brings nothing new, or a day going by, is the same item; a new commit behind is a change', () => {
  const rev = (over, now = NOW) => detectRepo({ repos: [repo({ behind: 2, ...over })] }, { now })[0].rev;
  assert.equal(rev({ fetchedAt: ago(30) }), rev({ fetchedAt: ago(5) }));
  assert.equal(rev({}), rev({}, NOW + 21 * 3600_000));
  assert.notEqual(rev({}), rev({ behind: 3 }));
});
