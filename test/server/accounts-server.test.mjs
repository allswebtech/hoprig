// The Accounts feature over real HTTP: adding API and TRouteAI accounts against stand-in endpoints, the account
// list and its actions, refusals and the rate limit, and the Claude subscription sign-in against a fake `claude`
// (link found, code typed, token saved and never shown, terminal cleaned up, timeout, cancel). No secret may
// appear in any response.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const box = sandbox('accounts-srv');
test.after(() => box.cleanup());
const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const KEY = 'gw-key-0123456789abcdef';
const ENV_FILE = path.join(box.root, 'fake-claude-env.json');
// A credential in the server's own environment must not reach `claude setup-token`.
process.env.ANTHROPIC_API_KEY = 'server-env-key-should-not-leak';

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { readProfile, writeProfile } = await import('../../src/profiles.mjs');
const { getAutoSwitch } = await import('../../src/autoswitch.mjs');
const { createServer } = await import('../../src/server/server.mjs');

// a gateway that wants Bearer and lists two models; refuses model "nope"
const seen = [];
const gw = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization || null, x: req.headers['x-api-key'] || null });
    const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: 'unauthorized' } });
    if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: 'combo-best' }, { id: 'openai/gpt-5-mini' }] });
    const b = JSON.parse(body);
    if (b.model === 'nope') return send(400, { error: { message: 'no such model: nope' } });
    return send(200, { id: 'm', content: [] });
  });
});
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const GW = `http://127.0.0.1:${gw.address().port}`;
test.after(() => { gw.closeAllConnections(); gw.close(); });

const trouteai = { status: async () => ({ installed: true, running: true, version: '1.0.8', url: GW }), profile: () => ({ env: { ANTHROPIC_BASE_URL: GW }, prerun: '/usr/bin/node /x/bin.mjs addons start trouteai' }) };

saveConfig({ claudeBin: FAKE_CLAUDE, server: { passwordHash: await hashPassword('right-password') } });
writeProfile('work', { label: 'Work' });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, accounts: { trouteai, times: { link: 4000, token: 4000, ttl: 60_000 } } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const bodies = []; // every response text, checked for secrets at the end
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
}

test('add an API account through a gateway: models, test, save, then manage it', async () => {
  let r = await call('/api/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.accounts.map((a) => a.name), ['work']);
  assert.equal(r.json.defaults.trouteai.baseUrl, GW);
  assert.match(r.json.defaults.subscription.name, /^sub\d+$/);

  for (const [bad, why] of [
    [{ baseUrl: 'https://u:p@x.com', key: KEY }, /key field/],
    [{ baseUrl: 'file:///etc', key: KEY }, /https/],
    [{ baseUrl: GW, key: 'with space 123' }, /whole key/],
    [{ baseUrl: GW, key: 'wrong-key-000000000' }, /refused \(401\)/],
    [{ account: 'nobody' }, /no such API provider/],
  ]) {
    r = await call('/api/accounts/probe', bad);
    assert.ok(r.status >= 400, JSON.stringify(bad));
    assert.match(r.json.error, why);
  }
  r = await call('/api/accounts/probe', { baseUrl: `${GW}/v1/`, key: KEY });
  assert.equal(r.status, 200);
  assert.equal(r.json.auth, 'Authorization: Bearer');
  assert.deepEqual(r.json.models.map((m) => m.id), ['combo-best', 'openai/gpt-5-mini']);
  const probe = r.json.probe;
  r = await call('/api/accounts/test', { probe, model: 'nope' });
  assert.deepEqual(r.json, { ok: false, error: 'The request was not accepted (400). The service said: "no such model: nope"' });
  r = await call('/api/accounts/test', { probe, model: 'combo-best' });
  assert.deepEqual(r.json, { ok: true });
  assert.equal((await call('/api/accounts/save', { probe, name: 'Work', model: 'combo-best' })).status, 409, 'name taken (names are lower case)');
  assert.equal((await call('/api/accounts/save', { probe, name: 'bad name', model: 'combo-best' })).status, 400);
  r = await call('/api/accounts/save', { probe, via: 'trouteai', name: '', label: '', model: 'combo-best', smallModel: 'openai/gpt-5-mini' });
  assert.deepEqual(r.json, { ok: true, name: 'api' });
  const p = readProfile('api');
  assert.equal(p.label, 'API via TRouteAI');
  assert.equal(p.prerun, '/usr/bin/node /x/bin.mjs addons start trouteai');
  assert.equal(p.models, '*=combo-best');
  assert.deepEqual(p.env, { ANTHROPIC_BASE_URL: GW, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'combo-best', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'openai/gpt-5-mini' });
  assert.equal((await call('/api/accounts/test', { probe, model: 'combo-best' })).status, 400, 'a saved probe is gone');

  // the list: kind, model, host, nothing secret
  r = await call('/api/accounts');
  const a = r.json.accounts.find((x) => x.name === 'api');
  assert.equal(a.kind, 'api');
  assert.equal(a.model, 'combo-best');
  assert.equal(a.host, new URL(GW).host);
  assert.equal(a.viaTrouteai, true);
  assert.equal(a.inAuto, false);

  // change model: the key comes from the profile file, not the page
  r = await call('/api/accounts/probe', { account: 'api' });
  assert.equal(r.status, 200);
  r = await call('/api/accounts/api/model', { probe: r.json.probe, model: 'openai/gpt-5-mini' });
  assert.equal(r.status, 200);
  assert.equal(readProfile('api').env.ANTHROPIC_MODEL, 'openai/gpt-5-mini');
  assert.equal(readProfile('api').models, '*=openai/gpt-5-mini');
  assert.equal(readProfile('api').env.ANTHROPIC_AUTH_TOKEN, KEY);

  // label, Auto order, delete
  assert.equal((await call('/api/accounts/api/label', { label: 'Gateway' })).status, 200);
  assert.equal(readProfile('api').label, 'Gateway');
  assert.equal((await call('/api/accounts/api/label', { label: 'x\ny' })).status, 400);
  await call('/api/accounts/api/auto', { on: true });
  assert.deepEqual(getAutoSwitch().order, ['api']);
  await call('/api/accounts/work/auto', { on: true });
  await call('/api/accounts/api/auto', { on: false });
  assert.deepEqual(getAutoSwitch().order, ['work']);
  assert.equal((await call('/api/accounts/nobody/delete', {})).status, 404);
  assert.equal((await call('/api/accounts/api/delete', {})).status, 200);
  assert.equal(readProfile('api'), null);
  assert.ok(seen.every((s) => s.x === null || s.x === KEY || s.x === 'wrong-key-000000000'));
});

test('a plain Anthropic key is stored as ANTHROPIC_API_KEY without a base URL', async () => {
  const anth = http.createServer((req, res) => {
    res.writeHead(req.headers['x-api-key'] === KEY ? 200 : 401, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/v1/models') ? JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }) : '{}');
  });
  await new Promise((r) => anth.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${anth.address().port}`;
  try {
    const r = await call('/api/accounts/probe', { baseUrl: url, key: KEY });
    assert.equal(r.json.auth, 'x-api-key');
    const s = await call('/api/accounts/save', { probe: r.json.probe, name: 'claude-api', label: 'Claude API', model: '' });
    assert.equal(s.status, 200);
    const p = readProfile('claude-api');
    assert.deepEqual(p.env, { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: KEY });
    assert.equal(p.models, '', 'no model picked: no rename');
  } finally {
    anth.closeAllConnections();
    anth.close();
  }
});

test('Claude subscription: link, a bad code, then a good code saves the token (never shown)', async () => {
  process.env.FAKE_CLAUDE_ENV_FILE = ENV_FILE;
  let r = await call('/api/accounts/subscription/start', { name: '', label: '' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.state, 'link');
  assert.match(r.json.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=/);
  const name = r.json.name;
  assert.match(name, /^sub\d+$/);
  assert.equal((await call('/api/accounts/subscription/start', {})).status, 409, 'one at a time');
  const env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
  assert.deepEqual(env.keys, [], 'no ANTHROPIC_* or OAuth token reached claude');
  assert.ok(env.browser, 'BROWSER is set so no browser opens on the PC');
  assert.ok(env.configDir.startsWith(os.tmpdir()), 'its own Claude folder');
  assert.equal((await call('/api/accounts/subscription/code', { code: 'x' })).status, 400, 'too short');
  r = await call('/api/accounts/subscription/code', { code: 'codewithouthash123' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not accepted/);
  assert.equal(fs.existsSync(env.configDir), false, 'the temporary Claude folder is removed');
  assert.equal((await call('/api/accounts/subscription')).json.state, 'error');

  r = await call('/api/accounts/subscription/start', { name: 'sub7', label: 'Second Max' });
  assert.equal(r.json.state, 'link');
  r = await call('/api/accounts/subscription/code', { code: 'abcDEF123456#stateXYZ' });
  assert.deepEqual(r.json, { state: 'done', name: 'sub7', label: 'Second Max', mode: 'add' });
  const p = readProfile('sub7');
  assert.equal(p.kind, 'subscription');
  assert.equal(p.label, 'Second Max');
  assert.equal(p.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-FAKEtokenFAKEtokenFAKEtoken_0123456789abcdefABCDEF-xyzAA');
  assert.equal(app.server && (await call('/api/accounts/subscription')).json.state, 'none', 'the flow is gone');
  assert.equal((await call('/api/accounts/subscription/code', { code: 'abcDEF123456#again' })).status, 409);
});

test('Claude subscription: cancel, no link (timeout), and Claude Code ending early', async () => {
  let r = await call('/api/accounts/subscription/start', {});
  assert.equal(r.json.state, 'link');
  assert.equal((await call('/api/accounts/subscription/cancel', {})).status, 200);
  assert.equal((await call('/api/accounts/subscription')).json.state, 'none');
  process.env.FAKE_CLAUDE_MODE = 'nolink';
  const t0 = Date.now();
  r = await call('/api/accounts/subscription/start', {});
  assert.equal(r.status, 502);
  assert.match(r.json.error, /no sign-in link.*terminal instead/);
  assert.ok(Date.now() - t0 < 8000);
  process.env.FAKE_CLAUDE_MODE = 'exit';
  r = await call('/api/accounts/subscription/start', {});
  assert.equal(r.status, 502);
  assert.match(r.json.error, /terminal instead/);
  delete process.env.FAKE_CLAUDE_MODE;
});

test('sign in again for an existing provider: replaced only on success; everything else of it stays', async () => {
  const NEW = 'sk-ant-oat01-FAKEtokenFAKEtokenFAKEtoken_0123456789abcdefABCDEF-xyzAA';
  const OLD = 'sk-ant-oat01-OLDsigninOLDsigninOLDsignin_0123456789abcdefABCDEF-oldAA';
  const { setAutoSwitch } = await import('../../src/autoswitch.mjs');
  const { profilesDir } = await import('../../src/paths.mjs');
  const fileOf = (name) => fs.readFileSync(path.join(profilesDir(), `${name}.env`), 'utf8');
  // a provider with an expired sign-in, its own settings, and a place in Auto mode's order
  writeProfile('team', { label: 'Team seat', prerun: 'true', models: 'claude-fable-*=claude-opus-5-5', env: { CLAUDE_CODE_OAUTH_TOKEN: OLD, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' } });
  setAutoSwitch({ order: ['work', 'team'] });
  const before = fileOf('team');

  // the refusals: an unknown mode, no name, a name that is no name, a provider that does not exist, an API key
  assert.equal((await call('/api/accounts/subscription/start', { mode: 'replace', name: 'team' })).status, 400);
  assert.equal((await call('/api/accounts/subscription/start', { mode: 'signin' })).status, 400);
  assert.equal((await call('/api/accounts/subscription/start', { mode: 'signin', name: '../team' })).status, 400);
  let r = await call('/api/accounts/subscription/start', { mode: 'signin', name: 'nobody' });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /There is no provider called "nobody"/);
  writeProfile('keyed', { label: 'Key', env: { ANTHROPIC_API_KEY: 'k-0123456789', ANTHROPIC_BASE_URL: GW } });
  r = await call('/api/accounts/subscription/start', { mode: 'signin', name: 'keyed' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /"keyed" uses an API key, not a sign-in/);
  // adding under the name is still refused, as before: only "signin" may touch an existing provider
  assert.equal((await call('/api/accounts/subscription/start', { name: 'team' })).status, 409);
  assert.notEqual((await call('/api/accounts/subscription')).json.state, 'link', 'no refusal started anything');

  // cancelled: the provider's file is untouched
  r = await call('/api/accounts/subscription/start', { mode: 'signin', name: 'team', label: 'ignored' });
  assert.deepEqual([r.status, r.json.state, r.json.name, r.json.label, r.json.mode], [200, 'link', 'team', 'Team seat', 'signin']);
  assert.equal((await call('/api/accounts/subscription')).json.mode, 'signin');
  assert.equal((await call('/api/accounts/subscription/cancel', {})).status, 200);
  assert.equal(fileOf('team'), before);

  // failed (the code is not accepted): untouched as well
  await call('/api/accounts/subscription/start', { mode: 'signin', name: 'team' });
  r = await call('/api/accounts/subscription/code', { code: 'codewithouthash123' });
  assert.equal(r.status, 400);
  assert.equal(fileOf('team'), before);

  // succeeded: the sign-in is replaced, and nothing else
  await call('/api/accounts/subscription/start', { mode: 'signin', name: 'team' });
  r = await call('/api/accounts/subscription/code', { code: 'abcDEF123456#stateXYZ' });
  assert.deepEqual(r.json, { state: 'done', name: 'team', label: 'Team seat', mode: 'signin' });
  const p = readProfile('team');
  assert.deepEqual([p.label, p.prerun, p.models, p.kind], ['Team seat', 'true', 'claude-fable-*=claude-opus-5-5', 'subscription']);
  assert.deepEqual(p.env, { CLAUDE_CODE_OAUTH_TOKEN: NEW, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' });
  assert.equal(fileOf('team'), before.replace(OLD, NEW), 'the same file but for the sign-in');
  assert.deepEqual(getAutoSwitch().order, ['work', 'team'], 'its place in the order is kept');
  assert.equal((fs.statSync(path.join(profilesDir(), 'team.env')).mode & 0o777).toString(8), '600');

  // a provider that used Claude Code's own stored login gets its sign-in in its own file, under the same name and label
  writeProfile('stored', { label: 'Claude account (stored login)' });
  await call('/api/accounts/subscription/start', { mode: 'signin', name: 'stored' });
  r = await call('/api/accounts/subscription/code', { code: 'abcDEF123456#stateXYZ' });
  assert.deepEqual(r.json, { state: 'done', name: 'stored', label: 'Claude account (stored login)', mode: 'signin' });
  assert.equal(readProfile('stored').env.CLAUDE_CODE_OAUTH_TOKEN, NEW);

  // deleted while the sign-in was open: nothing is created under its name
  writeProfile('gone', { label: 'Gone', env: { CLAUDE_CODE_OAUTH_TOKEN: OLD } });
  await call('/api/accounts/subscription/start', { mode: 'signin', name: 'gone' });
  fs.rmSync(path.join(profilesDir(), 'gone.env'));
  r = await call('/api/accounts/subscription/code', { code: 'abcDEF123456#stateXYZ' });
  assert.equal(r.status, 404);
  assert.equal(readProfile('gone'), null);
  assert.notEqual((await call('/api/accounts/subscription')).json.state, 'link');
  setAutoSwitch({ order: [] });
});

test('the whole flow times out', async () => {
  // The flow's clock starts with the sign-in program, and the stand-in shows its link 300 ms after it started. With
  // 800 ms for the whole flow a slow start on a busy computer used them up before the link came, and the start
  // itself failed. 3 s leave room for that; the flow still ends by itself, which is what is checked.
  const app2 = createServer({ backend, watch: false, accounts: { trouteai, times: { link: 4000, token: 4000, ttl: 3000 } } });
  const { port: p2 } = await app2.listen(0, '127.0.0.1');
  const b2 = `http://127.0.0.1:${p2}`;
  try {
    const l = await fetch(`${b2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify({ password: 'right-password' }) });
    const c2 = l.headers.get('set-cookie').split(';')[0];
    const go = (p, body) => fetch(b2 + p, { method: body ? 'POST' : 'GET', headers: { Origin: b2, Cookie: c2, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
    assert.equal((await go('/api/accounts/subscription/start', {})).state, 'link');
    let st;
    for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      st = await go('/api/accounts/subscription');
      if (st.state !== 'link') break;
    }
    assert.equal(st.state, 'error');
    assert.match(st.error, /longer than 10 minutes/);
  } finally {
    await app2.close();
  }
});

test('rate limit on checks that reach out with a key', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await call('/api/accounts/probe', { baseUrl: 'http://127.0.0.1:9', key: KEY });
  assert.equal(last.status, 429);
});

test('no response ever carried a key or token', () => {
  const all = bodies.join('\n');
  for (const secret of [KEY, 'sk-ant-oat01', 'server-env-key-should-not-leak', 'FAKEtoken', 'OLDsignin', 'k-0123456789']) assert.equal(all.includes(secret), false, secret);
});
