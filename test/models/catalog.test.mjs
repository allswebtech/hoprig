// The one list of a provider's models (src/models/catalog.mjs): each kind of provider, the fallback, the ten-minute
// keeping, the check of a model's name, and that no key or address is in what it gives.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('catalog');
test.after(() => box.cleanup());
const { FAIL_KEEP_MS, FAMILIES, KEEP_MS, SUBSCRIPTION_READ, forgetModels, idsWith, knownModelsFor, modelProblem, modelsFor, namedBy } = await import('../../src/models/catalog.mjs');

const KEY = 'sk-relay-test-key-0123456789';
const relay = { name: 'relay', kind: 'api', models: 'claude-fable-*=relay-big-1', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8241', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'relay-main-2' } };
const direct = { name: 'direct', kind: 'api', models: '', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } };
const sub = { name: 'team', kind: 'subscription', models: '', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } };

/** A stand-in endpoint: `answer(url, init)` → { status, body }; every call is counted. */
function endpoint(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, redirect: init.redirect });
    const r = await answer(String(url), init);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  };
  return { calls, fetchImpl };
}
const list = (n, prefix = 'm') => ({ data: Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, display_name: `Model ${i + 1}` })) });

test('a gateway: its own five models, then what the profile itself names, with what each says of itself', async () => {
  forgetModels();
  const e = endpoint(() => ({ body: { data: [
    { id: 'relay-main-2', display_name: 'Relay Main 2', capabilities: { effort_tiers: ['low', 'high'], context_window: 1_000_000, image_input: true } },
    ...list(4, 'relay').data,
  ] } }));
  const v = await modelsFor(relay, { fetchImpl: e.fetchImpl });
  assert.equal(v.source, 'endpoint');
  assert.equal(v.why, null);
  assert.deepEqual(v.models.map((m) => m.id), ['relay-main-2', 'relay-1', 'relay-2', 'relay-3', 'relay-4', 'relay-big-1']);
  assert.deepEqual(v.models[0], { id: 'relay-main-2', label: 'Relay Main 2', efforts: ['low', 'high'], window1m: true, images: true });
  assert.match(v.models.at(-1).label, /named by this provider/);
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].url, 'http://127.0.0.1:8241/v1/models?limit=1000');
  assert.equal(e.calls[0].redirect, 'manual', 'a redirect could carry the key elsewhere');
  assert.equal(e.calls[0].headers.Authorization, `Bearer ${KEY}`, 'asked with the profile\'s own key and header');
});

test('an API endpoint that lists forty: all forty', async () => {
  forgetModels();
  const e = endpoint(() => ({ body: list(40, 'claude-x') }));
  const v = await modelsFor(direct, { fetchImpl: e.fetchImpl });
  assert.equal(v.source, 'endpoint');
  assert.equal(v.models.length, 40);
  assert.equal(e.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(e.calls[0].headers['x-api-key'], direct.env.ANTHROPIC_API_KEY);
});

test('no list: the family names, a line that says why, and an exact name may be typed', async () => {
  const cases = [
    ['lists none', () => ({ body: { data: [] } }), /^This provider lists no models\.$/],
    ['is down', () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /^Could not get this provider's model list: the provider's address does not answer\.$/],
    ['has no such address', () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), /no computer has the provider's address/],
    ['has no list at its address', () => ({ status: 404, body: {} }), /this address has no model list \(404\)/],
    ['refuses the key', () => ({ status: 401, body: { error: { message: `bad key ${KEY}` } } }), /key was refused \(401\)/],
    ['has an error', () => ({ status: 500, body: 'oops' }), /had an error \(500\)/],
    ['answers no list', () => ({ body: '<html>hello</html>' }), /the answer held no model list/],
  ];
  for (const [what, answer, why] of cases) {
    forgetModels();
    const e = endpoint(answer);
    const v = await modelsFor(relay, { fetchImpl: e.fetchImpl });
    assert.equal(v.source, 'fallback', what);
    assert.equal(v.typed, true, what);
    assert.match(v.why, why, what);
    assert.deepEqual(v.models.slice(0, 3).map((m) => m.id), FAMILIES, what);
    assert.ok(v.models.some((m) => m.id === 'relay-main-2'), `${what}: the profile's own model is still offered`);
    assert.ok(!JSON.stringify(v).includes(KEY), `${what}: no key in what the page gets`);
    assert.doesNotMatch(v.why, /could not be had|E[A-Z]{3,}|check the address and the model name/, `${what}: plain words, no system code, no advice about a name he did not type`);
  }
  // A refused key is asked once more with the other header, never more.
  forgetModels();
  const e = endpoint(() => ({ status: 403, body: {} }));
  await modelsFor(relay, { fetchImpl: e.fetchImpl });
  assert.equal(e.calls.length, 2);
});

test('a Claude subscription: Claude Code\'s own models for it, read for one version, and no endpoint asked', async () => {
  const e = endpoint(() => assert.fail('a subscription is never asked'));
  const v = await modelsFor(sub, { fetchImpl: e.fetchImpl });
  assert.equal(v.source, 'subscription');
  assert.equal(v.read.tool, 'Claude Code');
  assert.match(SUBSCRIPTION_READ.version, /^\d+\.\d+\.\d+$/);
  const ids = v.models.map((m) => m.id);
  for (const id of ['fable', 'opus', 'opus[1m]', 'sonnet', 'haiku']) assert.ok(ids.includes(id), id);
  assert.ok(ids.length > 3, 'more than the three family names');
  assert.equal(v.models.find((m) => m.id === 'opus[1m]').window1m, true);
  const login = await modelsFor({ name: 'mine', kind: 'login', env: {} }, { fetchImpl: e.fetchImpl });
  assert.equal(login.source, 'subscription');
});

test('Auto mode: the family names; another coding tool: that tool\'s own list', async () => {
  assert.deepEqual((await modelsFor('auto')).models.map((m) => m.id), FAMILIES);
  const v = await modelsFor(relay, { tool: 'opencode', toolModels: async () => [{ id: 'relay-1', efforts: ['low'] }, 'relay-2', { id: 'bad id' }] });
  assert.equal(v.source, 'tool');
  assert.deepEqual(v.models.map((m) => m.id), ['relay-1', 'relay-2']);
});

test('the list is kept ten minutes per profile and its key, never shared with another profile', async () => {
  forgetModels();
  let t = 1_000_000;
  const now = () => t;
  const e = endpoint(() => ({ body: list(5, 'relay') }));
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  t += KEEP_MS - 1;
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  assert.equal(e.calls.length, 1, 'asked once within ten minutes');
  t += 1;
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  assert.equal(e.calls.length, 2, 'asked again after ten minutes');
  const other = endpoint(() => ({ body: list(2, 'other') }));
  const v = await modelsFor({ ...relay, name: 'relay2' }, { fetchImpl: other.fetchImpl, now });
  assert.deepEqual(v.models.map((m) => m.id).slice(0, 2), ['other-1', 'other-2'], 'another profile is asked for its own list');
  const changed = endpoint(() => ({ body: list(1, 'newkey') }));
  const w = await modelsFor({ ...relay, env: { ...relay.env, ANTHROPIC_AUTH_TOKEN: 'sk-relay-another-key-99' } }, { fetchImpl: changed.fetchImpl, now });
  assert.equal(w.models[0].id, 'newkey-1', 'a changed key is asked again');
});

test('a list that lies: bad ids, duplicates, hidden characters and a flood are cut to what is safe', async () => {
  forgetModels();
  const e = endpoint(() => ({ body: { data: [
    { id: 'ok-1', display_name: 'Ok‮ one\u0007' }, { id: 'ok-1' }, { id: 'has space' }, { id: '-starts-with-dash' }, { id: '<b>x</b>' }, { id: 'x'.repeat(200) }, null, 7,
    ...list(2000, 'flood').data,
  ] } }));
  const v = await modelsFor(relay, { fetchImpl: e.fetchImpl });
  assert.equal(v.models[0].id, 'ok-1');
  assert.equal(v.models[0].label, 'Ok one');
  assert.equal(v.models.filter((m) => m.id === 'ok-1').length, 1);
  assert.ok(!v.models.some((m) => /[\s<]/.test(m.id) || m.id.startsWith('-') || m.id.length > 120));
  assert.ok(v.models.length <= 500 + namedBy(relay).length);
});

test('a model\'s name is checked against what is known, never by asking', async () => {
  forgetModels();
  const never = { now: () => 0 };
  // Nothing known yet: a family name, a checked exact name, a saved value.
  assert.equal(modelProblem(relay, 'sonnet', never), null);
  assert.equal(modelProblem(relay, 'relay-anything-7', never), null);
  assert.match(modelProblem(relay, 'bad name', never), /not a model name/);
  assert.match(modelProblem(relay, '-x', never), /not a model name/);
  const e = endpoint(() => ({ body: list(5, 'relay') }));
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now: () => 0 });
  assert.equal(modelProblem(relay, 'relay-3', never), null);
  assert.equal(modelProblem(relay, 'relay-main-2', never), null, 'named by the profile');
  assert.match(modelProblem(relay, 'relay-99', never), /does not serve "relay-99"/);
  assert.equal(modelProblem(relay, 'relay-99', { ...never, saved: ['relay-99'] }), null, 'a saved value keeps working');
  assert.equal(modelProblem(relay, 'haiku', never), null, 'an old family name keeps working');
  assert.match(modelProblem(sub, 'claude-unknown-1'), /not one of the models Claude Code offers/);
  assert.equal(modelProblem(sub, 'opus[1m]'), null);
  // A saved model the list left: shown as it is, after the list.
  assert.deepEqual(idsWith(knownModelsFor(relay, never), ['relay-99']).slice(-1), ['relay-99']);
  assert.equal(knownModelsFor({ ...relay, name: 'never-asked' }).source, 'unknown');
});

test('a name and password in the provider\'s address never leave: the address is not asked, and no text holds them', async () => {
  forgetModels();
  const e = endpoint(() => assert.fail('an address with a name and password is never asked'));
  for (const base of ['http://alex:hunter2pass@127.0.0.1:8246', 'https://alex@relay.example.invalid', 'ftp://relay.example.invalid']) {
    const v = await modelsFor({ name: 'cred', kind: 'api', env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: KEY } }, { fetchImpl: e.fetchImpl });
    assert.equal(v.source, 'fallback', base);
    assert.match(v.why, /address/, base);
    const all = JSON.stringify(v);
    for (const bit of ['hunter2pass', 'alex', '127.0.0.1', 'relay.example.invalid', KEY]) assert.ok(!all.includes(bit), `${base}: "${bit}" is in what the page gets`);
  }
  assert.equal(e.calls.length, 0);
  // fetch's own error quotes the whole address: only a system code, or plain words, is kept of it.
  forgetModels();
  const thrown = endpoint(() => new TypeError('Request cannot be constructed from a URL that includes credentials: http://alex:hunter2pass@127.0.0.1:8241/v1/models'));
  const w = await modelsFor(relay, { fetchImpl: thrown.fetchImpl });
  assert.ok(!JSON.stringify(w).includes('hunter2pass') && !JSON.stringify(w).includes('127.0.0.1'), w.why);
  // The service's own words may quote an address with a password: cut.
  forgetModels();
  const quoted = endpoint(() => ({ status: 400, body: { error: { message: 'bad upstream http://alex:hunter2pass@relay.example.invalid/v1' } } }));
  const q = await modelsFor(relay, { fetchImpl: quoted.fetchImpl });
  assert.ok(!q.why.includes('hunter2pass'), q.why);
});

test('a failed ask is kept half a minute, not ten: an endpoint that comes back is asked again', async () => {
  forgetModels();
  let t = 5_000_000;
  const now = () => t;
  let up = false;
  const e = endpoint(() => (up ? { body: list(5, 'relay') } : Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
  assert.equal((await modelsFor(relay, { fetchImpl: e.fetchImpl, now })).source, 'fallback');
  up = true;
  t += FAIL_KEEP_MS - 1;
  assert.equal((await modelsFor(relay, { fetchImpl: e.fetchImpl, now })).source, 'fallback', 'not asked again at once');
  assert.equal(e.calls.length, 1);
  t += 1;
  const v = await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  assert.equal(v.source, 'endpoint', 'asked again after half a minute');
  assert.equal(e.calls.length, 2);
  assert.ok(FAIL_KEEP_MS <= 60_000 && FAIL_KEEP_MS < KEEP_MS);
  // A refused key (fixed outside the dashboard) is asked again too.
  forgetModels();
  let ok = false;
  const k = endpoint(() => (ok ? { body: list(2, 'relay') } : { status: 401, body: {} }));
  await modelsFor(relay, { fetchImpl: k.fetchImpl, now });
  ok = true;
  t += FAIL_KEEP_MS;
  assert.equal((await modelsFor(relay, { fetchImpl: k.fetchImpl, now })).source, 'endpoint');
});

test('pickers that open at the same moment share one ask', async () => {
  forgetModels();
  const e = endpoint(() => new Promise((r) => setTimeout(() => r({ body: list(5, 'relay') }), 50)));
  const views = await Promise.all([1, 2, 3, 4, 5].map(() => modelsFor(relay, { fetchImpl: e.fetchImpl })));
  assert.equal(e.calls.length, 1);
  for (const v of views) assert.equal(v.source, 'endpoint');
});

test('a list longer than is kept never refuses a name past the cut', async () => {
  forgetModels();
  const e = endpoint(() => ({ body: list(600, 'relay-m') }));
  const v = await modelsFor(relay, { fetchImpl: e.fetchImpl });
  assert.equal(v.cut, true);
  assert.equal(modelProblem(relay, 'relay-m-501'), null, 'served by the endpoint, past the 500 kept');
  assert.match(modelProblem(relay, 'bad name'), /not a model name/);
  forgetModels();
  const short = endpoint(() => ({ body: list(5, 'relay') }));
  assert.equal((await modelsFor(relay, { fetchImpl: short.fetchImpl })).cut, undefined);
  assert.match(modelProblem(relay, 'relay-99'), /does not serve/);
});

test('a list had once still decides the check after ten minutes; only a picker asks again', async () => {
  forgetModels();
  let t = 9_000_000;
  const now = () => t;
  const e = endpoint(() => ({ body: list(5, 'relay') }));
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  t += KEEP_MS + 60 * 60_000; // an hour later: a schedule at night
  assert.match(modelProblem(relay, 'paid-x-anything', { now }), /does not serve "paid-x-anything"/);
  assert.equal(modelProblem(relay, 'relay-3', { now }), null);
  assert.equal(e.calls.length, 1, 'the check asked nobody');
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  assert.equal(e.calls.length, 2, 'a picker that opens asks again');
});

test('a subscription: what Claude Code itself takes is accepted, one label per family, no exact ids beside the aliases', async () => {
  const v = await modelsFor(sub);
  const ids = v.models.map((m) => m.id);
  assert.ok(ids.includes('sonnet[1m]'), 'the 1M variants Claude Code\'s alias table has');
  assert.ok(!ids.some((id) => id.startsWith('claude-')), 'no "(exact)" copies of the families in the list');
  assert.ok(!v.models.some((m) => /opusplan/.test(m.label)), 'opusplan is said in words');
  for (const id of ['sonnet[1m]', 'fable[1m]', 'opusplan', 'claude-opus-4-1', 'claude-sonnet-5-5']) assert.equal(modelProblem(sub, id), null, `${id}: Claude Code takes it, without being passed as saved`);
  assert.match(modelProblem(sub, 'default'), /choose the default in the list/);
  assert.match(modelProblem(sub, 'claude-unknown-1'), /not one of the models Claude Code offers/);
  // The same family is described the same way on a subscription, in the fallback and in Auto mode.
  forgetModels();
  const down = await modelsFor(relay, { fetchImpl: endpoint(() => new TypeError('fetch failed')).fetchImpl });
  const auto = await modelsFor('auto');
  for (const id of FAMILIES) {
    const label = v.models.find((m) => m.id === id).label;
    assert.equal(down.models.find((m) => m.id === id).label, label, id);
    assert.equal(auto.models.find((m) => m.id === id).label, label, id);
  }
});


test('a saved model the provider\'s own list leaves out is named as such, for every menu; without a list nothing is', async () => {
  const { notListedOf, NOT_LISTED } = await import('../../src/models/catalog.mjs');
  const { choicesOf } = await import('../../src/chat/tools.mjs');
  const { modelSub } = await import('../../web/chat/words.js');
  const { writeProfile } = await import('../../src/profiles.mjs');
  assert.equal(NOT_LISTED, 'not in this provider\'s list');
  writeProfile('team', { label: 'Team', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  const ch = choicesOf('claude', 'team', () => ['old-model', 'sonnet']);
  assert.deepEqual(ch.notListed, ['old-model']);
  assert.equal(ch.models.at(-1), 'old-model', 'shown as it is, after the list');
  assert.match(modelSub('old-model', ch), /Not in this provider's list/);
  assert.equal(modelSub('sonnet', ch), '');
  assert.deepEqual(notListedOf({ source: 'fallback', models: [] }, ['claude-exact-7']), [], 'no list: nothing is "left out"');
  assert.deepEqual(notListedOf({ source: 'unknown', models: [] }, ['x-1']), []);
});

test('a password that holds a raw "@" is cut whole from the service\'s own words', async () => {
  const { scrub } = await import('../../src/server/endpoint.mjs');
  assert.equal(scrub('upstream http://bob:pa@ss2word@up.example.invalid/v1 failed'), 'upstream http://***@up.example.invalid/v1 failed');
  assert.equal(scrub('see https://relay.example.invalid/v1 and alex@box2'), 'see https://relay.example.invalid/v1 and alex@box2', 'an address without a name is left as it is');
  forgetModels();
  const quoted = endpoint(() => ({ status: 400, body: { error: { message: 'upstream http://bob:pa@ss2word@up.example.invalid/v1 failed' } } }));
  const v = await modelsFor(relay, { fetchImpl: quoted.fetchImpl });
  assert.ok(!v.why.includes('ss2word') && !v.why.includes('bob'), v.why);
});

test('a paged list (has_more) never refuses a name on a later page', async () => {
  forgetModels();
  const e = endpoint(() => ({ body: { ...list(100, 'relay-p'), has_more: true, last_id: 'relay-p-100' } }));
  const v = await modelsFor(relay, { fetchImpl: e.fetchImpl });
  assert.equal(v.cut, true);
  assert.equal(modelProblem(relay, 'relay-p-150'), null, 'on the second page');
  forgetModels();
  const last = endpoint(() => ({ body: { ...list(5, 'relay'), has_more: false } }));
  assert.equal((await modelsFor(relay, { fetchImpl: last.fetchImpl })).cut, undefined, 'the last page is a whole list');
  assert.match(modelProblem(relay, 'relay-99'), /does not serve/);
});

test('a subscription takes a known exact id also with its date or [1m] after it, as Claude Code cuts both itself', () => {
  for (const id of ['claude-sonnet-4-5-20250929', 'claude-opus-5-5[1m]', 'claude-sonnet-4-5-20250929[1m]', 'claude-opus-4-20250514', 'opus[1m]']) assert.equal(modelProblem(sub, id), null, id);
  for (const id of ['claude-unknown-1-20250101', 'claude-unknown-1[1m]', 'relay-1[1m]']) assert.match(modelProblem(sub, id), /not one of the models Claude Code offers/, id);
});

test('only what the check would refuse is marked as not in the list: not a family name, a name past a cut list, or an id a subscription takes', async () => {
  const { notListedOf } = await import('../../src/models/catalog.mjs');
  forgetModels();
  const two = endpoint(() => ({ body: { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] } }));
  const v = await modelsFor(direct, { fetchImpl: two.fetchImpl });
  assert.equal(modelProblem(direct, 'opus'), null);
  assert.deepEqual(notListedOf(v, ['opus', 'sonnet', 'haiku']), [], 'a family name works on every provider');
  assert.deepEqual(notListedOf(v, ['opus', 'relay-gone-9']), ['relay-gone-9'], 'a name the list leaves out is still marked');
  forgetModels();
  const big = await modelsFor(relay, { fetchImpl: endpoint(() => ({ body: list(600, 'relay-m') })).fetchImpl });
  assert.equal(modelProblem(relay, 'relay-m-550'), null);
  assert.deepEqual(notListedOf(big, ['relay-m-550']), [], 'past a cut list');
  const s = await modelsFor(sub);
  assert.equal(modelProblem(sub, 'claude-opus-4-1'), null);
  assert.deepEqual(notListedOf(s, ['claude-opus-4-1', 'claude-unknown-1']), ['claude-unknown-1'], 'an older exact id a subscription takes');
});

test('a fresh failure never hides a list that was had: the menu and the check keep the last list', async () => {
  forgetModels();
  let t = 7_000_000;
  const now = () => t;
  let up = true;
  const e = endpoint(() => (up ? { body: list(5, 'relay') } : Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  up = false;
  t += KEEP_MS; // the list is ten minutes old: a picker asks again, and the endpoint is down
  // The picker that asked and the check read the same list: the last one, with why the new ask failed.
  const asked = await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  assert.deepEqual([asked.source, asked.typed, asked.models.filter((m) => m.id.startsWith('relay-') && m.id !== 'relay-main-2' && m.id !== 'relay-big-1').length], ['endpoint', false, 5]);
  assert.match(asked.why, /does not answer.*listed last/);
  const known = knownModelsFor(relay, { now });
  assert.deepEqual(asked.models.map((m) => m.id), known.models.map((m) => m.id), 'the picker offers what the check takes');
  assert.equal(known.source, 'endpoint', 'an open chat\'s menu keeps the provider\'s five, not the three family names');
  assert.ok(known.models.some((m) => m.id === 'relay-3'));
  assert.match(modelProblem(relay, 'paid-x-anything', { now }), /does not serve "paid-x-anything"/, 'the check does not take any name');
  // Never a list had: the fresh failure decides, with its why.
  forgetModels();
  up = false;
  await modelsFor(relay, { fetchImpl: e.fetchImpl, now });
  const none = knownModelsFor(relay, { now });
  assert.equal(none.source, 'fallback');
  assert.match(none.why, /does not answer/);
});

test('a chat opened while an ask for its provider is on its way is still sent the list, with no second request', async () => {
  const { askDue } = await import('../../src/models/catalog.mjs');
  forgetModels();
  let release;
  const e = endpoint(() => new Promise((r) => { release = () => r({ body: list(5, 'relay') }); }));
  const first = modelsFor(relay, { fetchImpl: e.fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(askDue(relay), true, 'the second chat is due: it waits on the same ask');
  const second = modelsFor(relay, { fetchImpl: e.fetchImpl });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(e.calls.length, 1, 'one request only');
  assert.equal(a.source, 'endpoint');
  assert.equal(b.source, 'endpoint');
  assert.equal(askDue(relay), false, 'answered: not due for ten minutes');
});
