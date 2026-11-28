// Settings → While you are away: the first line is "Mend problems by itself", on for a fresh config, and its only write is
// operator.mends, through the operator route (web/automation.js): the automation route has no such setting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from '../chat/fakedom.mjs';

globalThis.localStorage = { getItem: () => null, setItem() {} };
const sent = [];
globalThis.fetch = async (url, o) => {
  sent.push({ url: String(url), body: o && o.body ? JSON.parse(o.body) : null });
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' };
};
const { rulesPart } = await import('../../web/automation.js');

const state = (extra = {}) => ({ restoreOn: true, ...extra, settings: { retry: { enabled: false }, idle: { shells: false, shellHours: 12, gateway: false, gatewayMinutes: 30 } } });
const rows = (part) => part.flatMap((p) => byClass(p, 'switchrow'));

test('the first row of While you are away is Mend problems by itself, on for a fresh config', () => {
  const [first] = rows(rulesPart(state(), () => {}));
  assert.match(texts(first).join(' '), /^Mend problems by itself/);
  assert.ok('checked' in byClass(first, 'switch')[0].attrs, 'on with nothing saved');
});

test('it shows off only when the owner turned it off', () => {
  const [first] = rows(rulesPart(state({ mends: false }), () => {}));
  assert.ok(!('checked' in byClass(first, 'switch')[0].attrs));
  const [on] = rows(rulesPart(state({ mends: true }), () => {}));
  assert.ok('checked' in byClass(on, 'switch')[0].attrs);
});

test('turning it off posts mends to the operator route and nothing to the automation route', async () => {
  sent.length = 0;
  const [first] = rows(rulesPart(state(), () => {}));
  await byClass(first, 'switch')[0].listeners.change({ target: { checked: false } });
  const post = sent.find((x) => /\/api\/operator\/settings$/.test(x.url));
  assert.deepEqual(post && post.body, { mends: false });
  assert.ok(!sent.some((x) => /\/api\/automation\/settings$/.test(x.url)), 'the automation route does not know this setting');
});
