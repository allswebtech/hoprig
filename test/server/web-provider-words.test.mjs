// "provider" stays the one name; where a newcomer meets it first it is said once in plain words beside it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from '../chat/fakedom.mjs';

const PLAIN = /AI account .*runs on \(a Claude subscription, an API key, a gateway\)/;

test('Get started: the second-provider step says what a provider is, once, and no other name for it', async () => {
  const { withProviderWords } = await import('../../web/getstarted.js');
  const onb = { steps: [{ id: 'claude', done: true, detail: 'ok' }, { id: 'account2', title: 'A second provider, for Auto mode', done: false, detail: 'when one provider reaches its limit, the session goes on with the next' }], done: 1, total: 2 };
  const s = withProviderWords(onb).steps[1];
  assert.equal(s.title, 'A second provider, for Auto mode', 'the title is the server\'s');
  assert.match(s.detail, /^when one provider reaches its limit, the session goes on with the next\. A provider is the /);
  assert.match(s.detail, PLAIN);
  assert.equal((s.detail.match(/AI account/g) || []).length, 1, 'said once');
  const done = withProviderWords({ ...onb, steps: [onb.steps[0], { ...onb.steps[1], done: true, detail: '2 providers' }] }).steps[1];
  assert.equal(done.detail, '2 providers', 'a done step keeps its count');
});

test('the chat\'s panel: the Provider row keeps its name and says in plain words what it is', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {} };
  globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: true, addEventListener() {} }));
  const R = await import('../../web/chat/rail.js');
  const rail = R.createRail({ A: '/x', view: () => 'normal', computer: () => 'This computer', providers() {} });
  rail.paint({ cwd: '/w/shop', short: '~/w/shop', branch: 'main', profile: { name: 'p', label: 'Example plan', kind: 'subscription' }, engine: { id: 'claude', capabilities: {} }, usage: {} });
  const rows = byClass(rail.el, 'chat-rail-rows')[0];
  const words = texts(rows).join(' | ');
  assert.match(words, /Provider/, 'the name stays');
  assert.equal(byClass(rows, 'chat-rail-said').length, 0, 'no block of text under the row');
  assert.match(R.PROVIDER_SAID, PLAIN, 'said in plain words, in the row\'s tooltip');
  assert.doesNotMatch(words, /AI connector|Separate copy/, 'no second name');
});
