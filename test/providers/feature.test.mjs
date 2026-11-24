// The Providers page's routes for one provider (src/providers/feature.mjs) over real HTTP, against a stand-in of the
// made-up gateway "Relay" that counts requests: a page view and a profile edit send nothing; a press sends the count it
// said; a gateway profile made through the product gets exactly one round by itself; a sign-in profile is never
// checked; no answer holds the key.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('providers-feature');
test.after(() => box.cleanup());
const KEY = 'sk-ant-api03-MADEUPKEY0000000000000000';

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { toolNames } = await import('../../src/providers/names.mjs');

const messages = []; // every POST /v1/messages the stand-in got
const relay = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'relay-large' }] }));
    const b = JSON.parse(raw || '{}');
    messages.push(b.model);
    const ok = b.model !== 'claude-opus-5';
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { type: 'message', content: [] } : { type: 'error', error: { type: 'invalid_request_error', message: `Ambiguous model '${b.model}' (key ${KEY})` } }));
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
test.after(() => relay.close());
const RELAY = `http://127.0.0.1:${relay.address().port}`;

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
// A Claude Code that takes the map (the installed one is not looked for here).
const app = createServer({ backend, watch: false, providers: { version: () => '2.1.328' } });
const { port } = await app.listen(0, '127.0.0.1');
test.after(() => app.close());
const base = `http://127.0.0.1:${port}`;
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const bodies = [];
async function call(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
}
const settle = async (n) => {
  const end = Date.now() + 10_000;
  while (messages.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200)); // and nothing more after it
};

const { providersFeature } = await import('../../src/providers/feature.mjs');

test('a page view and a profile edit send nothing; a press sends the count it said, and says the gap', async () => {
  writeProfile('relay-a', { label: 'Relay A', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  let r = await call('/api/providers/relay-a/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.check.applies, true);
  assert.equal(r.json.check.count, toolNames().length + 1);
  assert.equal(r.json.check.last, null);
  assert.equal((await call('/api/accounts/relay-a/label', { label: 'Relay A2' })).status, 200);
  await call('/api/accounts');
  await settle(0);
  assert.deepEqual(messages, [], 'nothing was sent');
  const said = r.json.check.count;
  r = await call('/api/providers/relay-a/check', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(messages.length, said);
  const gap = r.json.result.rows.find((x) => x.sends === 'claude-opus-5');
  assert.equal(gap.verdict, 'refused');
  assert.match(gap.mend.line, /combo named "claude-opus-5"/);
  assert.equal((await call('/api/providers/relay-a/check', {})).status, 429, 'a second press at once is refused');
  assert.equal(messages.length, said);
  r = await call('/api/providers/relay-a/health');
  assert.equal(r.json.check.last.at, gap && r.json.check.last.at);
  assert.equal(r.json.check.last.rows.length, said - 1);
  messages.length = 0;
});

test('a gateway profile made through the product gets exactly one round by itself', async () => {
  let r = await call('/api/accounts/probe', { baseUrl: RELAY, key: KEY });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call('/api/accounts/save', { probe: r.json.probe, name: 'relay-b', label: 'Relay B', model: '' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const n = toolNames().length + 1;
  await settle(n);
  assert.equal(messages.length, n);
  assert.ok((await call('/api/providers/relay-b/health')).json.check.last, 'its result is kept');
  messages.length = 0;
});

test('a sign-in profile is never checked, and an unknown name is refused', async () => {
  writeProfile('sub', { label: 'Claude account (stored login)' });
  const r = await call('/api/providers/sub/health');
  assert.deepEqual([r.json.check.applies, r.json.check.count], [false, 0]);
  assert.equal((await call('/api/providers/sub/check', {})).status, 409);
  assert.equal((await call('/api/providers/nobody/check', {})).status, 404);
  assert.equal((await call('/api/providers/..%2Fx/health')).status, 404);
  await settle(0);
  assert.deepEqual(messages, []);
});

test('no answer holds the key', () => {
  for (const b of bodies) assert.doesNotMatch(b, /MADEUPKEY|sk-ant-api03/);
});

// The routes alone, with the version of Claude Code and the caller given.
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const routeOf = (opts, ctxMore = {}) => {
  const f = providersFeature({ HttpError, caller: () => 'page', readJson: async () => ({}), ...ctxMore }, opts);
  return (method, p) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === method && r.test(p));
    return fn({ url: p }, re.exec(p));
  };
};

test('the map is said as the sessions get it: an older or unknown Claude Code gets only the small model renamed', async () => {
  writeProfile('relay-m', { label: 'Relay M', models: 'claude-opus-*=relay-large,claude-haiku-*=relay-small', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  const now = await routeOf({ version: () => '2.1.328' })('GET', '/api/providers/relay-m/health');
  assert.ok(now.map.rules.some((r) => r.from === 'claude-opus-5' && r.to === 'relay-large'));
  assert.equal(now.map.untaken, 0);
  for (const v of [null, '2.1.300']) {
    const old = await routeOf({ version: () => v })('GET', '/api/providers/relay-m/health');
    assert.deepEqual(old.map.rules.map((r) => r.by), ['small'], String(v));
    assert.ok(old.map.untaken > 0);
    assert.equal(old.map.version, v);
  }
});

test("another computer's page is told it cannot press here", async () => {
  writeProfile('relay-p', { label: 'Relay P', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  assert.equal((await routeOf({ version: () => null })('GET', '/api/providers/relay-p/health')).check.press, true);
  const other = await routeOf({ version: () => null }, { caller: () => 'computer' })('GET', '/api/providers/relay-p/health');
  assert.equal(other.check.press, false);
  assert.equal(other.check.applies, true, 'its check is still shown');
});

test('"Use this" puts the last check\'s MODELS line into the provider, only from the owner\'s page and only while its map is the same', async () => {
  const { readProfile } = await import('../../src/profiles.mjs');
  const { checkPlan } = await import('../../src/providers/check.mjs');
  writeProfile('relay-u', { label: 'Relay U', models: 'relay-x=relay-y', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  const r = await call('/api/providers/relay-u/check', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const gap = r.json.result.rows.find((x) => x.sends === 'claude-opus-5');
  assert.equal(gap.mend.models, 'MODELS=claude-opus-5=claude-opus-5-5,relay-x=relay-y');
  await assert.rejects(routeOf({}, { caller: () => 'computer' })('POST', '/api/providers/relay-u/mend'), (e) => e.status === 403);
  await assert.rejects(routeOf({}, { readJson: async () => ({ sends: 'claude-opus-5-5' }) })('POST', '/api/providers/relay-u/mend'), (e) => e.status === 404, 'a served name has no line');
  // The owner's one press puts the line in and turns the map on for sessions (the sheet asks him when it is off).
  const used = await routeOf({}, { readJson: async () => ({ sends: 'claude-opus-5', on: true }) })('POST', '/api/providers/relay-u/mend');
  assert.deepEqual(used, { ok: true, models: 'claude-opus-5=claude-opus-5-5,relay-x=relay-y', on: true });
  const p = readProfile('relay-u');
  assert.equal(p.models, 'claude-opus-5=claude-opus-5-5,relay-x=relay-y');
  assert.equal(p.env.ANTHROPIC_API_KEY, KEY, 'the key stays');
  assert.ok(!checkPlan(p, { version: '2.1.328' }).names.some((n) => n.sends === 'claude-opus-5'), 'a session no longer sends the refused name');
  // The map changed since the check: the line is not used again.
  await assert.rejects(routeOf({}, { readJson: async () => ({ sends: 'claude-opus-5' }) })('POST', '/api/providers/relay-u/mend'), (e) => e.status === 409);
  messages.length = 0;
});

test('the switch is turned on and off only from the owner\'s page, and a mend turns it on only when the press says so', async () => {
  const { readProfile } = await import('../../src/profiles.mjs');
  writeProfile('relay-s', { label: 'Relay S', models: 'claude-opus-*=relay-large', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  const h = await routeOf({ version: () => '2.1.328' })('GET', '/api/providers/relay-s/health');
  assert.equal(h.map.on, false, 'off for a provider that has MODELS but no switch');
  assert.ok(h.map.rules.some((r) => r.to === 'relay-large'), 'what a session WOULD send is shown');
  const map = (body, caller = 'page') => routeOf({}, { caller: () => caller, readJson: async () => body })('POST', '/api/providers/relay-s/map');
  for (const who of ['computer', 'self']) await assert.rejects(map({ on: true }, who), (e) => e.status === 403, who);
  await assert.rejects(map({ on: 'yes' }), (e) => e.status === 400);
  assert.equal(readProfile('relay-s').mapSessions, false);
  assert.deepEqual(await map({ on: true }), { ok: true, on: true });
  const p = readProfile('relay-s');
  assert.deepEqual([p.mapSessions, p.models, p.env.ANTHROPIC_API_KEY], [true, 'claude-opus-*=relay-large', KEY]);
  assert.equal((await routeOf({ version: () => '2.1.328' })('GET', '/api/providers/relay-s/health')).map.on, true);
  assert.deepEqual(await map({ on: false }), { ok: true, on: false });
  writeProfile('relay-none', { label: 'Relay None', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  await assert.rejects(routeOf({}, { readJson: async () => ({ on: true }) })('POST', '/api/providers/relay-none/map'), (e) => e.status === 409);
  // "Use this" without the owner's yes to the switch puts the line in and leaves the switch off.
  writeProfile('relay-v', { label: 'Relay V', models: 'relay-x=relay-y', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  assert.equal((await call('/api/providers/relay-v/check', {})).status, 200);
  const used = await routeOf({}, { readJson: async () => ({ sends: 'claude-opus-5' }) })('POST', '/api/providers/relay-v/mend');
  assert.equal(used.on, false);
  assert.equal(readProfile('relay-v').mapSessions, false);
  messages.length = 0;
});

test('a rename or another change of the provider keeps its switch as the owner set it', async () => {
  const { metaOf, readProfile } = await import('../../src/profiles.mjs');
  writeProfile('relay-k', { label: 'Relay K', models: 'claude-opus-*=relay-large', mapSessions: true, env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  const p = readProfile('relay-k');
  writeProfile('relay-k', { ...metaOf(p), label: 'Relay K renamed', env: p.env }); // what the label route writes
  assert.deepEqual([readProfile('relay-k').mapSessions, readProfile('relay-k').label], [true, 'Relay K renamed']);
  writeProfile('relay-k2', { label: 'Relay K2', models: 'claude-opus-*=relay-large', env: { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_API_KEY: KEY } });
  assert.equal(readProfile('relay-k2').mapSessions, false, 'a new provider is off until he says so');
});
