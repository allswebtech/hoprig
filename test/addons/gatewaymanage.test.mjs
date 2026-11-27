// TRouteAI managed in Hoprig's pages (src/addons/gatewaymanage.mjs): the routes answer the owner's page and a linked
// computer, never Tia's door; each change names this computer; every answer is free of keys and tokens; Add works by a
// pasted key, a code and a link; a sign-in step's temporary key is gone afterwards. Against a stand-in of the gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gatewayManageFeature, accountView, errorWords } from '../../src/addons/gatewaymanage.mjs';
import { CLI_TOKEN, LINK_CODE, SECRET, fakeManage } from '../gateway/fakemanage.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gmanage-'));
fs.writeFileSync(path.join(folder, 'cli-token'), `${CLI_TOKEN}\n`, { mode: 0o600 });

async function setup(fakeOpts = {}, extra = {}) {
  const gw = await fakeManage(fakeOpts);
  let clock = 1_000_000;
  const addon = { id: 'trouteai', title: 'TRouteAI', gateway: { port: () => gw.port } };
  const feature = gatewayManageFeature({ HttpError, readJson: async (req) => req.body, caller: (req) => req.caller || 'page' }, { addons: () => [addon, { id: 'mine', defined: true, gateway: { port: () => gw.port } }], computer: () => 'box2', folder: () => folder, deps: { sameUser: async () => 'own' }, now: () => clock, ...extra });
  const route = (method, p) => {
    const [pathname, query = ''] = p.split('?');
    for (const [m, re, fn] of feature.routes) {
      const hit = re.exec(pathname);
      if (hit && m === method) return (body = {}, caller, headers) => fn({ body, caller, headers }, hit, new URLSearchParams(query));
    }
    throw new Error(`no route ${method} ${p}`);
  };
  const answers = [];
  const ok = async (method, p, body) => {
    const r = await route(method, p)(method === 'POST' ? { confirm: 'box2', ...body } : body);
    answers.push(JSON.stringify(r));
    return r;
  };
  return { gw, route, ok, answers, tick: (ms) => (clock += ms), close: () => gw.close() };
}
const T = '/api/gatewayhost/trouteai';

test('the accounts, with each one\'s state in a word and its trouble in a sentence', async () => {
  const s = await setup();
  try {
    const r = await s.ok('GET', `${T}/accounts`);
    assert.equal(r.computer, 'box2');
    assert.deepEqual(r.accounts.map((a) => [a.name, a.state]), [['My OpenAI', 'ok'], ['Work Gemini', 'off']]);
    s.gw.state.providers[1].isActive = true;
    const again = await s.ok('GET', `${T}/accounts`);
    assert.equal(again.accounts[1].state, 'error');
    assert.equal(again.accounts[1].says, 'The provider refused the key or the sign-in. Add the account again.');
    assert.deepEqual(accountView({ id: 'a', on: true, limitedUntil: 5000 }, 1000).state, 'limited');
    assert.equal(errorWords('429 too many requests'), 'The provider says its limit is reached.');
  } finally {
    await s.close();
  }
});

test('test, off and on, and remove act on the account, each only on a press that names this computer', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await s.ok('POST', `${T}/accounts/p1/test`), { valid: true, says: null });
    const bad = await s.ok('POST', `${T}/accounts/p2/test`);
    assert.equal(bad.valid, false);
    assert.ok(!bad.says.includes(SECRET));
    await s.ok('POST', `${T}/accounts/p1/on`, { on: false });
    assert.equal(s.gw.state.providers[0].isActive, false);
    await assert.rejects(s.route('POST', `${T}/accounts/p1/on`)({ confirm: 'box2' }), (e) => e.status === 400);
    for (const body of [{}, { confirm: 'box3' }]) await assert.rejects(s.route('POST', `${T}/accounts/p1/remove`)(body), (e) => e.status === 400 && /confirm/.test(e.message));
    assert.equal(s.gw.state.providers.length, 2);
    await s.ok('POST', `${T}/accounts/p1/remove`);
    assert.deepEqual(s.gw.state.providers.map((p) => p.id), ['p2']);
  } finally {
    await s.close();
  }
});

test('Tia\'s caller is refused on every route and nothing reaches the gateway; another gateway is not managed', async () => {
  const s = await setup();
  try {
    const paths = [['GET', 'accounts'], ['GET', 'limits'], ['GET', 'providers'], ['GET', 'combos'], ['GET', 'combos/options'], ['GET', 'keys'], ['POST', 'accounts/p1/test'], ['POST', 'accounts/p1/on'], ['POST', 'accounts/p1/remove'], ['POST', 'add/key'], ['POST', 'add/code'], ['POST', 'add/poll'], ['POST', 'add/link'], ['POST', 'add/finish'], ['POST', 'add/cancel'], ['POST', 'combos/make'], ['POST', 'combos/c1/remove'], ['POST', 'keys/k1/remove'], ['POST', 'open']];
    const count = s.gw.state.calls.length;
    for (const [m, p] of paths) await assert.rejects(s.route(m, `${T}/${p}`)({ confirm: 'box2', on: true }, 'self'), (e) => e.status === 403, `${m} ${p}`);
    assert.equal(s.gw.state.calls.length, count);
    assert.equal(feature_count(paths), paths.length);
    await assert.rejects(s.route('GET', '/api/gatewayhost/mine/accounts')({}), (e) => e.status === 404);
    await assert.rejects(s.route('GET', '/api/gatewayhost/other/accounts')({}), (e) => e.status === 404);
  } finally {
    await s.close();
  }
});
const feature_count = (p) => p.length;

test('no answer holds a key, a token or a stored sign-in, whatever the gateway sends', async () => {
  const s = await setup({ catalog: [{ id: 'openai', name: 'OpenAI', category: 'api', flow: 'api-key', website: 'https://openai.com' }] });
  try {
    await s.ok('GET', `${T}/accounts`);
    await s.ok('GET', `${T}/limits`);
    await s.ok('GET', `${T}/limits?account=p1`);
    await s.ok('GET', `${T}/providers`);
    await s.ok('GET', `${T}/combos`);
    await s.ok('GET', `${T}/combos/options?name=gpt-5`);
    await s.ok('GET', `${T}/keys`);
    await s.ok('POST', `${T}/accounts/p2/test`);
    await s.ok('POST', `${T}/add/key`, { provider: 'openai', name: 'New', apiKey: SECRET });
    const all = s.answers.join('\n');
    assert.ok(!all.includes(SECRET) && !all.includes(CLI_TOKEN) && !all.includes('secretsecret') && !all.includes('verifier-SECRET') && !all.includes('dev-code-SECRET'));
    assert.ok(!/"(apiKey|accessToken|refreshToken|cookie|key|token)"/.test(all));
  } finally {
    await s.close();
  }
});

test('Add by a key: tested at once, the key goes only to the gateway; without a catalog it is still allowed', async () => {
  const s = await setup();
  try {
    const r = await s.ok('POST', `${T}/add/key`, { provider: 'openai', name: 'Second', apiKey: ' sk-abc123 ' });
    assert.equal(r.valid, true);
    assert.deepEqual(s.gw.state.calls.find((c) => c.method === 'POST' && c.url === '/api/providers').body, { provider: 'openai', apiKey: 'sk-abc123', name: 'Second' });
    for (const apiKey of ['', 'two words', 'x'.repeat(5000), 12]) await assert.rejects(s.route('POST', `${T}/add/key`)({ confirm: 'box2', provider: 'openai', apiKey }), (e) => e.status === 400);
    await assert.rejects(s.route('POST', `${T}/add/key`)({ confirm: 'box2', provider: 'Open AI!', apiKey: 'k' }), (e) => e.status === 400);
    const none = await s.ok('GET', `${T}/providers`);
    assert.equal(none.catalog, false);
    assert.match(none.sentence, /opens the gateway's own page/);
  } finally {
    await s.close();
  }
});

test('with a catalog, a provider takes only its own way in', async () => {
  const s = await setup({ catalog: [{ id: 'openai', name: 'OpenAI', flow: 'api-key' }, { id: 'kiro', name: 'Kiro', flow: 'device-code' }, { id: 'claude', name: 'Claude', flow: 'link-and-paste' }, { id: 'weird', name: 'Weird', flow: 'nonsense' }] });
  try {
    const c = await s.ok('GET', `${T}/providers`);
    assert.equal(c.catalog, true);
    assert.equal(c.providers.find((p) => p.id === 'weird').flow, 'own-page');
    await assert.rejects(s.route('POST', `${T}/add/key`)({ confirm: 'box2', provider: 'kiro', apiKey: 'k' }), (e) => e.status === 409 && /sign-in/.test(e.message));
    await assert.rejects(s.route('POST', `${T}/add/code`)({ confirm: 'box2', provider: 'openai' }), (e) => e.status === 409);
    await assert.rejects(s.route('POST', `${T}/add/link`)({ confirm: 'box2', provider: 'kiro' }), (e) => e.status === 409);
  } finally {
    await s.close();
  }
});

test('Add by a code: the page gets the code and the link, the poll is the page\'s, the temporary keys are gone', async () => {
  const s = await setup({ pendingPolls: 1 });
  try {
    const keys = s.gw.state.keys.length;
    const start = await s.ok('POST', `${T}/add/code`, { provider: 'kiro' });
    assert.equal(start.userCode, 'ABCD-1234');
    assert.equal(start.link, 'https://example.com/device');
    assert.deepEqual(Object.keys(start).sort(), ['expiresIn', 'interval', 'link', 'ticket', 'userCode']);
    assert.equal(s.gw.state.calls.filter((c) => c.url.includes('/poll')).length, 0, 'nothing polls by itself');
    assert.deepEqual(await s.ok('POST', `${T}/add/poll`, { ticket: start.ticket }), { pending: true });
    const polls = () => s.gw.state.calls.filter((c) => c.url.includes('/poll')).length;
    assert.equal(polls(), 1);
    assert.deepEqual(await s.ok('POST', `${T}/add/poll`, { ticket: start.ticket }), { pending: true });
    assert.equal(polls(), 1, 'a press sooner than the gateway\'s interval asks nothing');
    s.tick(6000);
    assert.deepEqual(await s.ok('POST', `${T}/add/poll`, { ticket: start.ticket }), { done: true });
    assert.equal(s.gw.state.calls.find((c) => c.url.includes('/poll')).body.deviceCode, 'dev-code-SECRET');
    assert.ok(s.gw.state.providers.some((p) => p.name === 'Signed in account'));
    assert.equal(s.gw.state.keys.length, keys, 'every temporary key was removed');
    await assert.rejects(s.route('POST', `${T}/add/poll`)({ confirm: 'box2', ticket: start.ticket }), (e) => e.status === 410, 'the ticket is used up');
  } finally {
    await s.close();
  }
});

test('a code that is not finished in time, or cancelled, is over', async () => {
  const s = await setup();
  try {
    const a = await s.ok('POST', `${T}/add/code`, { provider: 'kiro' });
    s.tick(901_000);
    await assert.rejects(s.route('POST', `${T}/add/poll`)({ confirm: 'box2', ticket: a.ticket }), (e) => e.status === 410 && /ran out of time/.test(e.message));
    const b = await s.ok('POST', `${T}/add/code`, { provider: 'kiro' });
    await s.ok('POST', `${T}/add/cancel`, { ticket: b.ticket });
    await assert.rejects(s.route('POST', `${T}/add/poll`)({ confirm: 'box2', ticket: b.ticket }), (e) => e.status === 410);
  } finally {
    await s.close();
  }
});

test('Add by a link: the address pasted back (or a bare code) is exchanged; another sign-in\'s address is refused', async () => {
  const s = await setup();
  try {
    const a = await s.ok('POST', `${T}/add/link`, { provider: 'claude' });
    assert.match(a.link, /^https:\/\/example\.com\/authorize/);
    await assert.rejects(s.route('POST', `${T}/add/finish`)({ confirm: 'box2', ticket: a.ticket, address: 'http://localhost:8080/callback?code=abc&state=other' }), (e) => e.status === 409);
    await assert.rejects(s.route('POST', `${T}/add/finish`)({ confirm: 'box2', ticket: a.ticket, address: 'http://localhost:8080/callback?nothing=1' }), (e) => e.status === 400);
    const r = await s.ok('POST', `${T}/add/finish`, { ticket: a.ticket, address: 'http://localhost:8080/callback?code=the-code-1&state=st-1' });
    assert.deepEqual(r, { done: true });
    const ex = s.gw.state.calls.find((c) => c.url.endsWith('/exchange'));
    assert.deepEqual(ex.body, { code: 'the-code-1', redirectUri: 'http://localhost:8080/callback', codeVerifier: 'verifier-SECRET', state: 'st-1' });
    assert.equal(s.gw.state.bearers.size, 0);
    const b = await s.ok('POST', `${T}/add/link`, { provider: 'claude' });
    await s.ok('POST', `${T}/add/finish`, { ticket: b.ticket, address: 'plain-code-123' });
    assert.equal(s.gw.state.calls.filter((c) => c.url.endsWith('/exchange')).at(-1).body.code, 'plain-code-123');
  } finally {
    await s.close();
  }
});

test('combos: listed, made from the gateway\'s own options (suggested by the model\'s name), removed', async () => {
  const s = await setup();
  try {
    assert.equal((await s.ok('GET', `${T}/combos`)).combos[0].models[1], 'gemini/gemini-3');
    const o = await s.ok('GET', `${T}/combos/options?name=claude-sonnet-4-5`);
    assert.deepEqual(o.suggested, ['openai/claude-sonnet-4-5']);
    assert.deepEqual(o.providers.map((p) => p.id), ['openai'], 'only accounts that are on');
    const made = await s.ok('POST', `${T}/combos/make`, { name: 'claude-sonnet-4-5' });
    assert.deepEqual(made.models, ['openai/claude-sonnet-4-5']);
    assert.deepEqual(s.gw.state.combos.at(-1).models, ['openai/claude-sonnet-4-5']);
    await assert.rejects(s.route('POST', `${T}/combos/make`)({ confirm: 'box2', name: 'unknown-model' }), (e) => e.status === 409 && e.details?.code === 'pick');
    await assert.rejects(s.route('POST', `${T}/combos/make`)({ confirm: 'box2', name: 'x', models: ['gemini/gemini-3'] }), (e) => e.status === 409 && /not offered/.test(e.message));
    await assert.rejects(s.route('POST', `${T}/combos/make`)({ confirm: 'box2', name: 'bad;name' }), (e) => e.status === 400);
    const picked = await s.ok('POST', `${T}/combos/make`, { name: 'my-own', models: ['openai/gpt-5'] });
    assert.deepEqual(picked.models, ['openai/gpt-5']);
    await s.ok('POST', `${T}/combos/c1/remove`);
    assert.ok(!s.gw.state.combos.some((c) => c.id === 'c1'));
  } finally {
    await s.close();
  }
});

test('keys: only the ones Hoprig made are listed and removed', async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.ok('GET', `${T}/keys`)).keys.map((k) => k.name), ['Hoprig sessions (box)']);
    await assert.rejects(s.route('POST', `${T}/keys/k2/remove`)({ confirm: 'box2' }), (e) => e.status === 409);
    assert.ok(s.gw.state.keys.some((k) => k.id === 'k2'));
    await s.ok('POST', `${T}/keys/k1/remove`);
    assert.ok(!s.gw.state.keys.some((k) => k.id === 'k1'));
  } finally {
    await s.close();
  }
});

const LOCAL = { where: 'local', host: 'localhost' };
const OWNER = { cookie: 'hoprig=1' };
const MARKED = { fixed: () => ({ mode: 'named', hostname: 'pc.example.com', extra: [{ hostname: 'tai-pc.example.com', port: 1, gateway: 'trouteai' }] }) };

test('Open on this computer: a one-time link on its own name, else url null with the line about its password', async () => {
  const none = await setup();
  try {
    assert.deepEqual(await none.ok('POST', `${T}/open`, LOCAL), { url: null, says: 'TRouteAI asks for the password you set for it.' });
    fs.writeFileSync(path.join(folder, 'initial-admin-password.txt'), 'x\n');
    const first = await none.ok('POST', `${T}/open`, LOCAL);
    assert.equal(first.url, null);
    assert.equal(first.says, `TRouteAI asks for its password. The first one is in the file ${path.join(folder, 'initial-admin-password.txt')} on box2.`);
    fs.rmSync(path.join(folder, 'initial-admin-password.txt'));
    for (const body of [{}, { where: 'local' }, { where: 'local', host: 'evil.example.com' }, { where: 'local', host: 'localhost:80' }]) {
      await assert.rejects(none.route('POST', `${T}/open`)({ confirm: 'box2', ...body }), (e) => e.status === 400, JSON.stringify(body));
    }
    await assert.rejects(none.route('POST', `${T}/open`)({ where: 'local', host: 'localhost' }), (e) => e.status === 400 && /confirm/.test(e.message));
  } finally {
    await none.close();
  }
  const s = await setup({ authLink: true });
  try {
    assert.deepEqual(await s.ok('POST', `${T}/open`, LOCAL), { url: `http://localhost:${s.gw.port}/login/link?code=${LINK_CODE}`, says: null });
    assert.equal((await s.ok('POST', `${T}/open`, { where: 'local', host: '127.0.0.1' })).url, `http://127.0.0.1:${s.gw.port}/login/link?code=${LINK_CODE}`);
  } finally {
    await s.close();
  }
});

test('Open keeps only the path and the code of what the gateway says: its origin, a foreign path or an extra query never count', async () => {
  const give = (url) => setup({ authLink: true }, { call: async () => ({ url }) });
  const keep = await give('https://tai-pc.example.com/login/link?code=ABC_def-123');
  try {
    assert.equal((await keep.ok('POST', `${T}/open`, LOCAL)).url, `http://localhost:${keep.gw.port}/login/link?code=ABC_def-123`, 'a public base the gateway was given does not break the local case');
  } finally {
    await keep.close();
  }
  for (const bad of ['https://evil.example/login?code=1', 'http://127.0.0.1:1/login/link?code=a&next=/x', 'http://127.0.0.1:1/login/link?next=/x', 'http://127.0.0.1:1/login/link?code=has space', `http://127.0.0.1:1/login/link?code=${'a'.repeat(129)}`, 'http://127.0.0.1:1/login/linkx?code=a', 'nonsense']) {
    const other = await give(bad);
    try {
      assert.equal((await other.ok('POST', `${T}/open`, LOCAL)).url, null, bad);
    } finally {
      await other.close();
    }
  }
});

test('Open on the public name: only the owner\'s own browser, only while the name is on; a token or no cookie gets url null', async () => {
  const s = await setup({ authLink: true }, MARKED);
  try {
    const pub = { confirm: 'box2', where: 'public', host: 'tai-pc.example.com' };
    assert.deepEqual(await s.route('POST', `${T}/open`)(pub, undefined, OWNER), { url: `https://tai-pc.example.com/login/link?code=${LINK_CODE}`, says: null });
    assert.equal((await s.route('POST', `${T}/open`)(pub, undefined, {})).url, null, 'no sign-in cookie');
    await assert.rejects(s.route('POST', `${T}/open`)(pub, 'self', OWNER), (e) => e.status === 403, 'Tia');
  } finally {
    await s.close();
  }
  const hub = await setup({ authLink: true }, { ...MARKED, tokenOf: () => 'tok1' });
  try {
    const r = await hub.route('POST', `${T}/open`)({ confirm: 'box2', where: 'public', host: 'x' }, undefined, OWNER);
    assert.equal(r.url, null, 'a hub\'s machine token never gets a public code');
    assert.equal(hub.gw.state.calls.some((c) => c.url === '/api/auth/link'), false, 'and no code was even made');
  } finally {
    await hub.close();
  }
  const off = await setup({ authLink: true }, { fixed: () => ({ mode: 'named', hostname: 'pc.example.com', extra: [] }) });
  try {
    const r = await off.route('POST', `${T}/open`)({ confirm: 'box2', where: 'public', host: 'x' }, undefined, OWNER);
    assert.deepEqual(r, { url: null, says: 'TRouteAI opens here once its public address is on.' });
  } finally {
    await off.close();
  }
  const old = await setup({}, MARKED);
  try {
    const r = await old.route('POST', `${T}/open`)({ confirm: 'box2', where: 'public', host: 'x' }, undefined, OWNER);
    assert.deepEqual(r, { url: null, says: 'TRouteAI asks for the password you set for it.' }, '1.0.11: its sign-in page asks for the password');
  } finally {
    await old.close();
  }
});

test('a listener that is not the user\'s gets nothing and the answer says so', async () => {
  const s = await setup({}, { deps: { sameUser: async () => 'foreign' } });
  try {
    await assert.rejects(s.route('GET', `${T}/accounts`)({}), (e) => e.status === 409 && /not yours/.test(e.message));
    assert.equal(s.gw.state.calls.length, 0);
  } finally {
    await s.close();
  }
});
