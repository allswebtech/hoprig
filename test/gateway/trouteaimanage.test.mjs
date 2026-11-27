// TRouteAI's management client (src/gateway/trouteaimanage.mjs) against a stand-in of its routes: only the listed calls
// are sent; the command token goes only to a listener of this user, at 127.0.0.1, read fresh; every answer is filtered;
// a sign-in act gets a temporary manage key that is removed right after, also on failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALLOWED, callGateway, ManageError, plain, scrub, withManageKey } from '../../src/gateway/trouteaimanage.mjs';
import { CHALLENGE, CLI_TOKEN, LINK_CODE, SECRET, fakeManage } from './fakemanage.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tmanage-'));
const tokenFile = path.join(folder, 'cli-token');
fs.writeFileSync(tokenFile, `${CLI_TOKEN}\n`, { mode: 0o600 });
const own = { sameUser: async () => 'own' };
const on = (gw) => ({ port: gw.port, folder, deps: own });
const fails = async (p, code) => assert.rejects(p, (e) => e instanceof ManageError && (!code || e.code === code) && !e.message.includes(SECRET) && !e.message.includes(CLI_TOKEN));

test('the accounts list keeps only the listed fields and no credential', async () => {
  const gw = await fakeManage();
  try {
    const r = await callGateway('GET', '/api/providers', on(gw));
    assert.deepEqual(r.accounts.map((a) => [a.id, a.provider, a.name, a.on]), [['p1', 'openai', 'My OpenAI', true], ['p2', 'gemini', 'Work Gemini', false]]);
    const text = JSON.stringify(r);
    assert.ok(!text.includes(SECRET), 'no secret value comes through');
    assert.ok(!/"(apiKey|accessToken|refreshToken|idToken|cookie|providerSpecificData)"/.test(text), 'no credential field comes through');
    assert.match(r.accounts[1].lastError, /invalid key/, 'the error text stays, without the key in it');
  } finally {
    await gw.close();
  }
});

test('the command token goes in its header only, to 127.0.0.1, read fresh for each call, with no forwarding header', async () => {
  const gw = await fakeManage();
  try {
    await callGateway('GET', '/api/combos', on(gw));
    const h = gw.state.calls.at(-1).headers;
    assert.equal(h['x-trouteai-cli-token'], CLI_TOKEN);
    assert.equal(h.host, `127.0.0.1:${gw.port}`);
    assert.ok(!h.forwarded && !h['x-forwarded-for'] && !h['x-real-ip'] && !h.authorization && !h.cookie);
    // The file changed: the next call uses what it holds now (the gateway refuses the old one: it is the new that is read).
    fs.writeFileSync(tokenFile, `${'ee'.repeat(32)}\n`, { mode: 0o600 });
    await fails(callGateway('GET', '/api/combos', on(gw)), 'refused');
    assert.equal(gw.state.calls.at(-1).headers['x-trouteai-cli-token'], 'ee'.repeat(32));
    fs.writeFileSync(tokenFile, `${CLI_TOKEN}\n`, { mode: 0o600 });
    // A file others can read is not used: nothing is sent.
    fs.chmodSync(tokenFile, 0o644);
    const before = gw.state.calls.length;
    if (process.platform !== 'win32') {
      await fails(callGateway('GET', '/api/combos', on(gw)), 'token');
      assert.equal(gw.state.calls.length, before);
    }
    fs.chmodSync(tokenFile, 0o600);
  } finally {
    await gw.close();
  }
});

test('a listener that is not this user\'s, or none, gets nothing and the sentence says why', async () => {
  const gw = await fakeManage();
  try {
    for (const [who, code] of [['foreign', 'foreign'], ['none', 'down']]) {
      await fails(callGateway('GET', '/api/providers', { port: gw.port, folder, deps: { sameUser: async () => who } }), code);
    }
    assert.equal(gw.state.calls.length, 0, 'not one request was sent');
  } finally {
    await gw.close();
  }
});

test('the real listener check sees this process\'s own server as own (Linux)', { skip: process.platform !== 'linux' }, async () => {
  const gw = await fakeManage();
  try {
    const r = await callGateway('GET', '/api/combos', { port: gw.port, folder });
    assert.equal(r.combos.length, 1);
  } finally {
    await gw.close();
  }
});

test('only the listed calls are sent; the routes that give out credentials are not on the list', async () => {
  const gw = await fakeManage();
  try {
    for (const [m, p] of [['GET', '/api/providers/client'], ['GET', '/api/settings/export-json'], ['GET', '/api/db-backups/export'], ['GET', '/api/keys/k1/reveal'], ['DELETE', '/api/providers'], ['PUT', '/api/providers/p1'], ['GET', '/api/providers/p1'], ['GET', '/api/providers/../keys'], ['POST', '/api/oauth/openai/import-token'], ['GET', '/api/oauth/x/y/z'], ['GET', 'http://evil.example/api/providers']]) {
      await fails(callGateway(m, p, on(gw)), 'not-allowed');
    }
    assert.equal(gw.state.calls.length, 0);
    assert.ok(ALLOWED.every((e) => !/export|reveal|client|import|paste-credentials/.test(String(e.re))));
    // A call that makes a key is for the temporary sign-in step only.
    await fails(callGateway('POST', '/api/keys', { ...on(gw), body: { name: 'x', scopes: ['manage'] } }), 'not-allowed');
    assert.equal(gw.state.calls.length, 0);
  } finally {
    await gw.close();
  }
});

test('a sign-in act gets a temporary manage key, used for its calls and removed right after; the OAuth route refuses the token', async () => {
  const gw = await fakeManage();
  try {
    await fails(callGateway('GET', '/api/oauth/kiro/device-code', { ...on(gw), bearer: undefined }), 'internal');
    const keysBefore = gw.state.keys.length;
    const r = await withManageKey(on(gw), async (send) => {
      const d = await send('GET', '/api/oauth/kiro/device-code');
      assert.equal(d.userCode, 'ABCD-1234');
      assert.equal(d.deviceCode, 'dev-code-SECRET', 'the act itself keeps what it needs');
      return send('POST', '/api/oauth/kiro/poll', { deviceCode: d.deviceCode });
    });
    assert.equal(r.pending, true);
    const made = gw.state.calls.find((c) => c.method === 'POST' && c.url === '/api/keys');
    assert.deepEqual(made.body.scopes, ['manage']);
    assert.equal(made.headers['x-trouteai-cli-token'], CLI_TOKEN);
    assert.equal(gw.state.keys.length, keysBefore, 'the temporary key is gone');
    assert.equal(gw.state.bearers.size, 0);
    const oauth = gw.state.calls.filter((c) => c.url.startsWith('/api/oauth/'));
    assert.ok(oauth.length === 2 && oauth.every((c) => /^Bearer sk-made-/.test(c.headers.authorization) && !c.headers['x-trouteai-cli-token']));
    // A failing act still removes the key.
    await assert.rejects(withManageKey(on(gw), async (send) => send('POST', '/api/oauth/kiro/poll', {})), (e) => e instanceof ManageError && e.status === 409);
    assert.equal(gw.state.keys.length, keysBefore);
    // A key that cannot be removed is said by its name.
    await assert.rejects(withManageKey({ ...on(gw), deps: { ...own, fetch: (u, o) => (o.method === 'DELETE' ? Promise.reject(new Error('down')) : fetch(u, o)) } }, async () => 1), (e) => e.code === 'left-key' && /Hoprig sign-in step/.test(e.leftKey));
  } finally {
    await gw.close();
  }
});

test('the plain sentences: refused token, missing token, silence, an absent route, a bad port', async () => {
  const gw = await fakeManage();
  try {
    fs.writeFileSync(tokenFile, `${'ee'.repeat(32)}\n`, { mode: 0o600 });
    await assert.rejects(callGateway('GET', '/api/combos', on(gw)), /did not accept Hoprig's command token/);
    fs.writeFileSync(tokenFile, `${CLI_TOKEN}\n`, { mode: 0o600 });
    await assert.rejects(callGateway('GET', '/api/providers/catalog', on(gw)), (e) => e.code === 'absent' && e.status === 404);
    await assert.rejects(callGateway('GET', '/api/combos', { port: 80, folder, deps: own }), /port is not a usable number/);
    // The gateway runs but has no token file (a version before the one that writes it, or started before its files were updated).
    await assert.rejects(callGateway('GET', '/api/combos', { ...on(gw), folder: path.join(folder, 'nope') }), (e) => e.code === 'token' && /has no command token file/.test(e.message) && /Restart/.test(e.message) && /older than 1\.0\.11/.test(e.message) && !/once from Hoprig/.test(e.message));
    // A token file that others can read keeps its own sentence.
    // (Windows has no file mode bits: a file others can read cannot be made there, and the product does not look.)
    if (process.platform !== 'win32') {
      const open = fs.mkdtempSync(path.join(os.tmpdir(), 'tmanage-open-'));
      fs.writeFileSync(path.join(open, 'cli-token'), `${CLI_TOKEN}\n`, { mode: 0o644 });
      await assert.rejects(callGateway('GET', '/api/combos', { ...on(gw), folder: open }), (e) => e.code === 'token' && /others can read it/.test(e.message));
    }
    await assert.rejects(callGateway('GET', '/api/combos', { ...on(gw), deps: { ...own, timeoutMs: 80, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })))) } }), /did not answer in time/);
    await assert.rejects(callGateway('GET', '/api/combos', { ...on(gw), deps: { ...own, fetch: () => Promise.reject(new Error('ECONNREFUSED')) } }), /does not answer on port/);
  } finally {
    await gw.close();
  }
});

test('plain() and scrub() drop what looks like a key or a credential field', () => {
  assert.ok(!plain(`failed with ${SECRET} and AIzaSyA1234567890abcdefgh`).includes('sk-super'));
  assert.equal(plain('word '.repeat(100), 20).length, 20);
  assert.deepEqual(scrub({ a: 1, apiKey: 'x', nested: { refresh_token: 'y', ok: [{ Authorization: 'z', fine: 2 }] }, key: 'k' }), { a: 1, nested: { ok: [{ fine: 2 }] } });
});

test('an id the gateway made (a UUID) comes through whole: the real gateway names its keys, accounts and combos so', async () => {
  const uuid = (n) => `${n}27458c9-2ed9-4a8e-bba8-df40e131b28${n}`;
  const gw = await fakeManage();
  try {
    gw.state.keys[0].id = uuid(2);
    gw.state.combos[0].id = uuid(3);
    gw.state.providers[0].id = uuid(4);
    assert.equal((await callGateway('GET', '/api/keys', on(gw))).keys[0].id, uuid(2));
    assert.equal((await callGateway('GET', '/api/combos', on(gw))).combos[0].id, uuid(3));
    assert.equal((await callGateway('GET', '/api/providers', on(gw))).accounts[0].id, uuid(4));
  } finally {
    await gw.close();
  }
});

test('a custom provider\'s long name (openai-compatible-chat-<uuid>) stays whole in accounts and in the combo builder\'s models', async () => {
  const custom = 'openai-compatible-chat-8b7323dc-d1f5-4cbd-851a-725cef246f2b';
  const gw = await fakeManage();
  const real = globalThis.fetch;
  try {
    gw.state.providers[0].provider = custom;
    const accounts = await callGateway('GET', '/api/providers', on(gw));
    assert.equal(accounts.accounts[0].provider, custom);
    const opts = await callGateway('GET', '/api/combos/builder/options', { ...on(gw), deps: { ...own, fetch: async (url, init) => {
      const r = await real(url, init);
      const j = await r.json();
      j.providers = [{ providerId: custom, displayName: 'Mock', activeConnectionCount: 1, models: [{ id: 'gpt-mock', qualifiedModel: `${custom}/gpt-mock`, name: 'gpt-mock' }] }];
      return new Response(JSON.stringify(j), { status: 200 });
    } } });
    assert.equal(opts.providers[0].id, custom);
    assert.equal(opts.providers[0].models[0].qualified, `${custom}/gpt-mock`);
  } finally {
    await gw.close();
  }
});

test('a sign-in link keeps its long parts whole: the one-time code and the code challenge are as long as a key, and a link without them opens nothing', async () => {
  const gw = await fakeManage({ authLink: true });
  try {
    const open = await callGateway('POST', '/api/auth/link', { ...on(gw), body: {} });
    assert.ok(open.url.endsWith(`code=${LINK_CODE}`), open.url);
    const auth = await withManageKey(on(gw), (send) => send('GET', '/api/oauth/claude/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback'));
    assert.ok(auth.authUrl.includes(`code_challenge=${CHALLENGE}`), auth.authUrl);
  } finally {
    await gw.close();
  }
});
