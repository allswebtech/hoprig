// Auto mode's router when its order leaves providers out for a reason other than pay-per-use: an order of only gone
// providers and providers that do not serve Claude Code says why in the router's own sentence, and a running Auto
// session whose own provider is left out is still served while a subscription is in the order. Stand-in endpoints and
// made-up providers only: no real account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-router-left-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;

const seen = [];
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization || req.headers['x-api-key'] || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
const uPort = await new Promise((r) => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
process.env.HOPRIG_ANTHROPIC_URL = `http://127.0.0.1:${uPort}`;

const P = await import('../src/profiles.mjs');
const A = await import('../src/autoswitch.mjs');
const R = await import('../src/router.mjs');
const { saveConfig } = await import('../src/config.mjs');

P.writeProfile('sub', { label: 'Shop plan' });
P.writeProfile('key', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-made-up' } });
P.writeProfile('oai', { label: 'Example OpenAI', env: { OPENAI_API_KEY: 'demo-not-a-key' } });

const router = R.createRouter({ key: 'k'.repeat(48), log: () => {}, version: 'test' });
const rPort = await new Promise((r) => router.listen(0, '127.0.0.1', () => r(router.address().port)));
const base = `http://127.0.0.1:${rPort}/${'k'.repeat(48)}`;
test.after(() => {
  router.close(); upstream.close();
  router.closeAllConnections(); upstream.closeAllConnections();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SID = '22222222-2222-4222-8222-222222222222';
const ask = async (as = '') => {
  const r = await fetch(`${base}${as ? `/as/${as}` : ''}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat01-held-by-claude-code', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': SID },
    body: JSON.stringify({ model: 'claude-fable-5-2', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await r.json();
  return [r.status, body.error ? body.error.message : 'served'];
};

test('an order of only a gone provider and one that does not serve Claude Code: the router says why in its own sentence', async () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['ghost', 'oai'], payPerUse: true } });
  const before = seen.length;
  const left = A.leftOutOfOrder();
  assert.deepEqual(left, [{ name: 'ghost', why: 'missing' }, { name: 'oai', why: 'tools', label: 'Example OpenAI' }]);
  const want = 'hoprig: Auto mode has nothing it may use, because ghost in its order does not exist any more, and Example OpenAI does not serve Claude Code: put a provider that serves Claude Code into the order on the Providers page, or run: hoprig auto order <provider> <provider>.';
  assert.equal(`hoprig: ${R.nothingUsableWhy(left)}.`, want);
  assert.deepEqual(await ask(), [503, want]);
  assert.doesNotMatch((await ask())[1], /no providers in its order/);
  assert.equal(seen.length, before, 'nothing reached a provider');
});

test('a running Auto session whose own provider is left out, with a subscription still in the order', async () => {
  // Gone since the session started: the subscription of the order serves it.
  saveConfig({ autoSwitch: { enabled: true, order: ['key', 'sub'], payPerUse: false } });
  let before = seen.length;
  assert.deepEqual(await ask('gone'), [200, 'served']);
  assert.equal(seen.length, before + 1, 'the subscription was asked');
  // Billed by use while pay-per-use is off: refused, by the rule that nothing paid runs while the switch is off; the
  // router cannot pass it to the subscription (only Claude Code itself sends a subscription's token), so it says how.
  before = seen.length;
  const [status, said] = await ask('key');
  assert.equal(status, 503);
  assert.match(said, /^hoprig: this session runs as API, which is billed by use, and "Also use pay-per-use providers" is off/);
  assert.match(said, /start the session again under Auto mode\.$/);
  assert.equal(seen.length, before, 'nothing paid was asked');
});
