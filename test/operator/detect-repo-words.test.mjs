import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRepo } from '../../src/operator/detect/repo.mjs';
import { ACTS } from '../../src/operator/item.mjs';
import { NOW, ago } from './fixtures/cases.mjs';

const repo = (over) => ({ name: 'example/shop', path: 'shop/code/shop', project: 'shop', branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: 0, fetchedAt: ago(30), ...over });
const GIT_WORDS = /fast-forward|\bbehind\b|\bahead\b|not pushed|upstream/i;

// What the item says is read by someone who is not a programmer: plain words, the buttons doing what they did.
test('a repository item says in plain words what is on the git server and what is only here', () => {
  const [only] = detectRepo({ repos: [repo({ behind: 3 })] }, { now: NOW });
  assert.equal(only.why, 'Newer work of others is on the git server; bringing it here changes nothing of yours.');
  assert.ok(only.facts.includes('3 newer commits on the git server, not here yet'), only.facts.join('|'));
  assert.equal(only.recommended, 'sync');
  const [mine] = detectRepo({ repos: [repo({ ahead: 1 })] }, { now: NOW });
  assert.ok(mine.facts.includes('1 commit here not yet sent to the git server'), mine.facts.join('|'));
  assert.equal(mine.recommended, 'push');
  const [both] = detectRepo({ repos: [repo({ behind: 2, ahead: 1 })] }, { now: NOW });
  assert.ok(both.facts.includes('2 newer commits on the git server, not here yet, 1 commit here not yet sent to the git server'), both.facts.join('|'));
  const [alone] = detectRepo({ repos: [repo({ branch: 'try-x', upstream: null })] }, { now: NOW });
  assert.ok(alone.facts.includes('the branch is not on the git server: it exists only here'), alone.facts.join('|'));
  for (const it of [only, mine, both, alone]) {
    for (const line of [...it.facts.slice(1), it.why]) assert.doesNotMatch(line, GIT_WORDS, line);
  }
  assert.doesNotMatch(ACTS.sync.effect, GIT_WORDS, 'the button\'s own words');
  assert.equal(ACTS.sync.label, 'Bring up to date');
  assert.equal(ACTS.push.label, 'Push the branch');
  // One name for one thing on the same card: the push button's effect says "git server" too, never "remote".
  assert.equal(ACTS.push.effect, 'Sends it to the git server, where others see it.');
  assert.doesNotMatch(ACTS.push.effect, /\bremote\b/);
});
