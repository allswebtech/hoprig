// Unit tests for the Accounts feature: validation, reading `claude setup-token` output (a recording of the real
// CLI), and talking to an endpoint (model list by either header, the test request, refusals, no redirects).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';
import {
  cleanBaseUrl, cleanKey, cleanModel, explain, findSigninError, findSigninUrl, findToken, listModels, plainText, scrub,
  signinEnv, testModel,
} from '../../src/server/accounts.mjs';
import { tokenMayReach } from '../../src/machines/index.mjs';

const box = sandbox('accounts');
test.after(() => box.cleanup());
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('base URL, key and model validation', () => {
  assert.equal(cleanBaseUrl('https://api.anthropic.com/'), 'https://api.anthropic.com');
  assert.equal(cleanBaseUrl('http://localhost:20017/v1'), 'http://localhost:20017');
  assert.equal(cleanBaseUrl(' https://gw.example.com/proxy/v1/ '), 'https://gw.example.com/proxy');
  for (const [bad, why] of [
    ['ftp://x', /https/], ['javascript:alert(1)', /https/], ['https://user:pw@x.com', /key field/], ['https://x.com/?k=1', /\?/],
    ['not a url', /web address/], ['', /address/], ['https://x.com/#a', /\?/], [`https://x.com/${'a'.repeat(400)}`, /address/],
  ]) assert.throws(() => cleanBaseUrl(bad), why, bad);
  assert.equal(cleanKey(' sk-abc12345 '), 'sk-abc12345');
  for (const bad of ['short', 'has space 12345', 'a\nb12345678', 42]) assert.throws(() => cleanKey(bad), /whole key/);
  assert.equal(cleanModel('claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(cleanModel('openrouter/google/gemini-2.5-pro'), 'openrouter/google/gemini-2.5-pro');
  assert.equal(cleanModel('', { optional: true }), '');
  for (const bad of ['', 'a b', 'x;rm', 'x'.repeat(121)]) assert.throws(() => cleanModel(bad), /model/);
});

test('the real `claude setup-token` output (recorded from 2.1.325) yields the sign-in link', () => {
  const real = fs.readFileSync(path.join(FIX, 'setup-token-2.1.325.txt'), 'utf8');
  const url = findSigninUrl(real);
  assert.ok(url && url.startsWith('https://claude.com/cai/oauth/authorize?code=true&client_id='), url);
  assert.match(plainText(real), /Paste code here if prompted >/);
  assert.match(plainText(real), /This will guide you through long-lived/);
  // the same link without the hyperlink markers, wrapped at 80 columns with Ink's cursor jumps
  const ascii = url.replace(/%E2%80%A6/g, 'AbC123'); // the recording has the one-time values masked
  const bare = ascii.replace(/(.{80})/g, '$1\r\n');
  assert.equal(findSigninUrl(`\x1b[2G\x1b[38;5;246mBrowser didn't open?\x1b[39m\r\n\r\n${bare}\r\n\r\n\x1b[2GPaste\x1b[8Gcode`), ascii);
  // a link to anywhere else is not offered
  assert.equal(findSigninUrl('\x1b]8;;https://evil.example/oauth/authorize?x=1\x07x\x1b]8;;\x07'), null);
  assert.equal(findSigninUrl('https://claude.com/somewhere-else'), null);
});

test('token, errors and scrubbing', () => {
  const ok = '\x1b[2GYour\x1b[7GOAuth\x1b[13Gtoken:\r\n\x1b[2G\x1b[38;5;220msk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz_0123-45\x1b[39m\r\n';
  assert.equal(findToken(ok), 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz_0123-45');
  assert.equal(findToken('no token here sk-ant-oat01-short'), null);
  assert.match(findSigninError('\x1b[2GInvalid code. Please make sure the full code was copied\r\n'), /^Invalid code/);
  assert.equal(scrub('key sk-ant-api03-SECRETSECRET and Bearer abc.def and mykey123456', 'mykey123456'), 'key *** and Bearer *** and ***');
});

test('the sign-in runs without any account credential and without opening a browser on the PC', () => {
  const env = signinEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', ANTHROPIC_BASE_URL: 'z', CLAUDE_CODE_OAUTH_TOKEN: 'w', ANTHROPIC_MODEL: 'm', HOPRIG_PROFILE: 'p' }); // seal: a value no program is started with
  assert.deepEqual(Object.keys(env).filter((k) => /ANTHROPIC|OAUTH|HOPRIG_PROFILE/.test(k)), []);
  assert.ok(env.BROWSER);
  assert.equal(env.PATH, '/bin');
});

test('account routes are not reachable with another dashboard\'s token', () => {
  for (const p of ['/api/accounts', '/api/accounts/probe', '/api/accounts/subscription/start', '/api/accounts/x/delete']) assert.equal(tokenMayReach(p), false, p);
});

// ---------- stand-in endpoints ----------

function endpoint(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, base: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } })));
}
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const KEY = 'test-key-0123456789';

test('model list with x-api-key, with Bearer, without a list, and a refused key', async () => {
  const anth = await endpoint((req, res) => (req.headers['x-api-key'] === KEY ? json(res, 200, { data: [{ id: 'claude-sonnet-4-5', display_name: 'Sonnet' }, { id: 'bad id' }] }) : json(res, 401, { error: { message: 'invalid x-api-key' } })));
  const gw = await endpoint((req, res) => (req.headers.authorization === `Bearer ${KEY}` ? json(res, 200, { data: [{ id: 'combo-fast' }, { id: 'openai/gpt-5' }] }) : json(res, 401, { error: 'unauthorized' })));
  const bare = await endpoint((req, res) => json(res, 404, { error: 'not found' }));
  try {
    assert.deepEqual(await listModels(fetch, anth.base, KEY), { auth: 'x', models: [{ id: 'claude-sonnet-4-5', name: 'Sonnet' }], note: '' });
    assert.equal(anth.seen[0].headers['anthropic-version'], '2023-06-01');
    const g = await listModels(fetch, gw.base, KEY);
    assert.equal(g.auth, 'bearer');
    assert.deepEqual(g.models.map((m) => m.id), ['combo-fast', 'openai/gpt-5']);
    assert.equal(gw.seen.length, 2, 'x-api-key tried first, then Bearer');
    assert.deepEqual(await listModels(fetch, bare.base, KEY), { auth: null, models: null, note: 'This service has no model list; type the model name.' });
    await assert.rejects(listModels(fetch, anth.base, 'wrong-key-0000000'), (e) => e.status === 400 && /refused \(401\)/.test(e.message) && /invalid x-api-key/.test(e.message));
    await assert.rejects(listModels(fetch, 'http://127.0.0.1:9', KEY), (e) => e.status === 502 && /Cannot reach/.test(e.message));
  } finally {
    anth.close(); gw.close(); bare.close();
  }
});

test('an open model list proves nothing: the test request finds the header the service really wants', async () => {
  const ep = await endpoint((req, res) => {
    if (req.url.startsWith('/v1/models')) return json(res, 200, { data: [{ id: 'combo' }] }); // open to anyone
    return req.headers.authorization === `Bearer ${KEY}` ? json(res, 200, {}) : json(res, 401, { error: 'auth' });
  });
  try {
    const l = await listModels(fetch, ep.base, KEY);
    assert.equal(l.auth, 'x');
    assert.deepEqual(await testModel(fetch, ep.base, KEY, l.auth, 'combo'), { ok: true, auth: 'bearer' });
    assert.equal((await listModels(fetch, ep.base, KEY, 'bearer')).auth, 'bearer', 'an account\'s own header first');
  } finally {
    ep.close();
  }
});

test('a redirect is never followed with the key', async () => {
  const other = await endpoint((req, res) => json(res, 200, { data: [{ id: 'm' }] }));
  const redirecting = await endpoint((req, res) => {
    res.writeHead(302, { location: `${other.base}/v1/models` });
    res.end();
  });
  try {
    const r = await listModels(fetch, redirecting.base, KEY).catch((e) => e);
    assert.equal(other.seen.length, 0, 'the other host never saw a request');
    assert.ok(!(r instanceof Error) || /redirect/.test(r.message));
    const t = await testModel(fetch, redirecting.base, KEY, 'x', 'm');
    assert.equal(t.ok, false);
    assert.match(t.error, /redirect \(302\)/);
    assert.equal(other.seen.length, 0);
  } finally {
    other.close(); redirecting.close();
  }
});

test('the test request: success, plain-words errors, the key never in an error', async () => {
  const ep = await endpoint((req, res, body) => {
    const b = JSON.parse(body || '{}');
    if (req.headers['x-api-key'] !== KEY) return json(res, 401, { error: { message: `bad key ${req.headers['x-api-key']}` } });
    if (b.model === 'gone') return json(res, 404, { error: { type: 'not_found_error', message: 'model: gone' } });
    if (b.model === 'broke') return json(res, 429, { error: { message: 'Your credit balance is too low' } });
    assert.equal(b.max_tokens, 1);
    return json(res, 200, { id: 'msg', content: [] });
  });
  try {
    assert.deepEqual(await testModel(fetch, ep.base, KEY, 'x', 'claude-x'), { ok: true, auth: 'x' });
    assert.deepEqual(await testModel(fetch, ep.base, KEY, null, 'claude-x'), { ok: true, auth: 'x' });
    assert.match((await testModel(fetch, ep.base, KEY, 'x', 'gone')).error, /Not found .*model: gone/);
    assert.match((await testModel(fetch, ep.base, KEY, 'x', 'broke')).error, /no credit left \(429\).*credit balance is too low/);
    const leaked = await testModel(fetch, ep.base, 'wrong-key-1234567', 'x', 'claude-x');
    assert.match(leaked.error, /refused \(401\)/);
    assert.doesNotMatch(leaked.error, /wrong-key-1234567/, 'the key the service echoed back is cut out');
    assert.match(explain({ status: 503, json: null }, 'h', ''), /overloaded/);
  } finally {
    ep.close();
  }
});
