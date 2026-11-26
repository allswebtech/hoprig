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

// The stand-in Claude Code is a Node script (fixtures/fake-claude.mjs) started as the program itself through its #!
// line: Windows cannot start it so (error 193), so a test that runs it is skipped there.
const STANDIN = { skip: process.platform === 'win32' && 'the stand-in is started through its #! line' };

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
let overloaded = false; // Claude's API of the stand-in answers 529 (overloaded) while this is on
const gw = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization || null, x: req.headers['x-api-key'] || null });
    const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: 'unauthorized' } });
    if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: 'combo-best' }, { id: 'openai/gpt-5-mini' }] });
    if (overloaded && req.url === '/v1/messages') return send(529, { error: { type: 'overloaded_error', message: 'Overloaded' } });
    const b = JSON.parse(body);
    if (b.model === 'nope') return send(400, { error: { message: 'no such model: nope' } });
    return send(200, { id: 'm', content: [] });
  });
});
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const GW = `http://127.0.0.1:${gw.address().port}`;
test.after(() => { gw.closeAllConnections(); gw.close(); });

// Today's gateway as the accounts route sees an add-on of it (src/addons/localgateway.mjs), at the stand-in's address.
const trouteai = {
  id: 'trouteai', title: 'TRouteAI', words: { what: 'w', choice: 'c', add: 'a', key: 'k' }, page: () => GW,
  status: async () => ({ installed: true, running: true, version: '1.0.8', url: GW }),
  profile: () => ({ name: 'api', label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: GW }, prerun: '/usr/bin/node /x/bin.mjs addons start trouteai' }),
};

saveConfig({ claudeBin: FAKE_CLAUDE, server: { passwordHash: await hashPassword('right-password') } });
writeProfile('work', { label: 'Work' });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
let codexIn = false; // what Hoprig's Codex says of its own sign-in (a stand-in)
const app = createServer({ backend, watch: false, accounts: { gateways: [trouteai], times: { link: 4000, token: 4000, ttl: 60_000 }, codexSignedIn: async () => codexIn } });
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
  assert.deepEqual(r.json.gateways.map((g) => [g.id, g.title, g.defaults.baseUrl, g.defaults.name, g.page]), [['trouteai', 'TRouteAI', GW, 'api', GW]]);
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
  assert.deepEqual(a.viaGateway, { id: 'trouteai', title: 'TRouteAI' });
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

test('Claude subscription: link, a bad code, then a good code saves the token (never shown)', STANDIN, async () => {
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

test('Claude subscription: cancel, no link (timeout), and Claude Code ending early', STANDIN, async () => {
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

test('sign in again for an existing provider: replaced only on success; everything else of it stays', STANDIN, async () => {
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
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(profilesDir(), 'team.env')).mode & 0o777).toString(8), '600');

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

test('the whole flow times out', STANDIN, async () => {
  // The flow's clock starts with the sign-in program, and the stand-in shows its link 300 ms after it started. With
  // 800 ms for the whole flow a slow start on a busy computer used them up before the link came, and the start
  // itself failed. 3 s leave room for that; the flow still ends by itself, which is what is checked.
  const app2 = createServer({ backend, watch: false, accounts: { gateways: [trouteai], times: { link: 4000, token: 4000, ttl: 3000 } } });
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

test('an OpenAI-compatible key: added, which offered tools it serves, and Test saves the API shapes; no Codex sign-in kind', async () => {
  // A stand-in for OpenAI's API: Bearer only; responses and chat completions, no Claude messages.
  const hits = [];
  const oai = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: 'bad key' } });
    if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] });
    if (req.url === '/v1/responses' || req.url === '/v1/chat/completions') return send(200, { id: 'r' });
    return send(404, { error: { message: 'not here' } });
  });
  await new Promise((r) => oai.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${oai.address().port}`;
  try {
    let r = await call('/api/accounts');
    assert.equal(r.json.defaults.openai.baseUrl, 'https://api.openai.com');
    assert.equal(r.json.defaults.codex, undefined, 'Codex is not offered: no Codex sign-in to add');
    r = await call('/api/accounts/probe', { baseUrl: `${url}/v1`, key: KEY, via: 'openai' });
    assert.equal(r.json.auth, 'Authorization: Bearer');
    const probe = r.json.probe;
    r = await call('/api/accounts/test', { probe, model: 'gpt-x' });
    assert.deepEqual(r.json, { ok: true });
    assert.ok(!hits.includes('/v1/messages'), 'an OpenAI key is not tried on Claude\'s API');
    r = await call('/api/accounts/save', { probe, via: 'openai', name: '', label: '', model: 'gpt-x' });
    assert.deepEqual(r.json, { ok: true, name: 'openai' });
    const p = readProfile('openai');
    assert.equal(p.kind, 'openai');
    assert.deepEqual(p.env, { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: url });
    assert.deepEqual(p.api, ['responses', 'chat', 'models']);
    r = await call('/api/accounts');
    let a = r.json.accounts.find((x) => x.name === 'openai');
    assert.deepEqual([a.kind, a.host, a.model, a.tools], ['openai', new URL(url).host, 'gpt-x', ['opencode']], 'OpenCode uses an OpenAI key (chat completions)');

    // Test on the provider: asks every shape again and saves what answered; the label and model stay.
    await call('/api/accounts/openai/label', { label: 'My OpenAI' });
    hits.length = 0;
    r = await call('/api/accounts/openai/test', {});
    assert.deepEqual(r.json, { ok: true, shapes: ['responses', 'chat', 'models'], kept: [], tools: ['opencode'] }, 'a clear "not here" (404) for Claude\'s API');
    assert.ok(hits.includes('/v1/messages') && hits.includes('/v1/responses') && hits.includes('/v1/chat/completions'));
    assert.equal(readProfile('openai').label, 'My OpenAI');
    assert.equal(readProfile('openai').models, '*=gpt-x');
    // Change model keeps the shapes; an OpenAI provider cannot be "signed in again".
    r = await call('/api/accounts/probe', { account: 'openai' });
    assert.equal((await call('/api/accounts/openai/model', { probe: r.json.probe, model: 'gpt-y' })).status, 200);
    assert.deepEqual([readProfile('openai').models, readProfile('openai').api, readProfile('openai').env.OPENAI_API_KEY], ['*=gpt-y', ['responses', 'chat', 'models'], KEY]);
    r = await call('/api/accounts/subscription/start', { mode: 'signin', name: 'openai' });
    assert.equal(r.status, 409);

    // A gateway that answers everything: Test finds every API (the offered tools are named).
    writeProfile('gw3', { label: 'GW', env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'combo-best' } });
    r = await call('/api/accounts');
    assert.deepEqual(r.json.accounts.find((x) => x.name === 'gw3').tools, ['claude', 'opencode'], 'before Test: Claude\'s API only');
    r = await call('/api/accounts/gw3/test', {});
    assert.deepEqual(r.json, { ok: true, shapes: ['messages', 'responses', 'chat', 'models'], kept: [], tools: ['claude', 'opencode'] });
    assert.equal(readProfile('gw3').env.ANTHROPIC_MODEL, 'combo-best');
    // Claude's API overloaded at the moment of a Test: it is not taken away (an overload says nothing about the API).
    overloaded = true;
    try {
      r = await call('/api/accounts/gw3/test', {});
      assert.deepEqual(r.json, { ok: true, shapes: ['messages', 'responses', 'chat', 'models'], kept: ['messages'], tools: ['claude', 'opencode'] });
      assert.deepEqual(readProfile('gw3').api, ['messages', 'responses', 'chat', 'models']);
      r = await call('/api/sessions', { dir: os.homedir(), profile: 'gw3', mode: 'new' });
      assert.doesNotMatch(String(r.json.error || ''), /cannot be used for Claude Code/, 'Claude Code still starts on it');
      // ... and never added by one either: a provider not known to answer it before does not get it.
      writeProfile('gw5', { label: 'GW5', api: ['responses', 'chat'], env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'combo-best' } });
      r = await call('/api/accounts/gw5/test', {});
      assert.deepEqual([r.json.shapes, r.json.kept], [['responses', 'chat', 'models'], []]);
    } finally {
      overloaded = false;
    }
    // A refused key: nothing saved, the reason said.
    writeProfile('gw4', { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_AUTH_TOKEN: 'wrong-key-000000000', ANTHROPIC_MODEL: 'combo-best' } });
    r = await call('/api/accounts/gw4/test', {});
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /refused \(401\)/);
    assert.deepEqual(readProfile('gw4').api, []);

    // Codex is not offered: no Codex sign-in is added, and one that a version offering it made is kept and listed as
    // a provider this version cannot use (not an error, nothing asks Codex).
    r = await call('/api/accounts/codex-signin', {});
    assert.deepEqual([r.status, r.json.error], [404, 'Codex is not part of this version of Hoprig.']);
    assert.equal(readProfile('chatgpt'), null, 'nothing written');
    writeProfile('chatgpt', { label: 'ChatGPT account', signin: 'codex' });
    codexIn = 'never asked';
    a = (await call('/api/accounts')).json.accounts.find((x) => x.name === 'chatgpt');
    assert.deepEqual([a.kind, a.tools, a.host, a.unusable, 'signedIn' in a], ['chatgpt', [], '', true, false]);
    assert.equal((await call('/api/accounts/chatgpt/test', {})).status, 409);
    r = await call('/api/accounts/subscription/start', { mode: 'signin', name: 'chatgpt' });
    assert.deepEqual([r.status, r.json.error], [409, '"chatgpt" is a sign-in this version of Hoprig cannot use']);
    // A Claude session or chat cannot start on these.
    const st = (await call('/api/state')).json;
    assert.deepEqual([st.profiles.find((x) => x.name === 'chatgpt').tools, st.profiles.find((x) => x.name === 'chatgpt').unusable], [[], true]);
    assert.deepEqual(st.profiles.find((x) => x.name === 'openai').tools, ['opencode']);
    // A key that answers only Codex's API serves no coding tool of this version: the same `unusable`, on both lists.
    writeProfile('resp', { label: 'Responses only', api: ['responses'], env: { OPENAI_API_KEY: 'sk-resp-only-0123456789' } });
    a = (await call('/api/accounts')).json.accounts.find((x) => x.name === 'resp');
    assert.deepEqual([a.kind, a.tools, a.unusable, 'signedIn' in a], ['openai', [], true, false]);
    const st2 = (await call('/api/state')).json;
    assert.deepEqual([st2.profiles.find((x) => x.name === 'resp').tools, st2.profiles.find((x) => x.name === 'resp').unusable], [[], true]);
    assert.equal(st2.profiles.find((x) => x.name === 'openai').unusable, undefined);
    await call('/api/accounts/resp/delete', {});
    r = await call('/api/sessions', { dir: os.homedir(), profile: 'openai', mode: 'new' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /cannot be used for Claude Code/);
    for (const n of ['openai', 'chatgpt', 'gw3', 'gw4', 'gw5']) await call(`/api/accounts/${n}/delete`, {});
  } finally {
    oai.closeAllConnections();
    oai.close();
  }
});

test('the kept Codex sign-in kind, as it works once Codex is offered (the registry\'s full list)', async () => {
  const { anyTool } = await import('../../src/codetools/index.mjs');
  let signedIn = false;
  const app3 = createServer({ backend, watch: false, accounts: { gateways: [trouteai], findTool: anyTool, codexSignedIn: async () => signedIn } });
  const { port: p3 } = await app3.listen(0, '127.0.0.1');
  const b3 = `http://127.0.0.1:${p3}`;
  try {
    const l = await fetch(`${b3}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b3 }, body: JSON.stringify({ password: 'right-password' }) });
    const c3 = l.headers.get('set-cookie').split(';')[0];
    const go = (p, body) => fetch(b3 + p, { method: body ? 'POST' : 'GET', headers: { Origin: b3, Cookie: c3, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() }));
    let r = await go('/api/accounts');
    assert.equal(r.json.defaults.codex.name, 'chatgpt');
    r = await go('/api/accounts/codex-signin', {});
    assert.deepEqual(r.json, { ok: true, name: 'chatgpt' });
    const a = () => go('/api/accounts').then((x) => x.json.accounts.find((y) => y.name === 'chatgpt'));
    assert.deepEqual(await a().then((x) => [x.label, x.tools, x.signedIn, x.unusable]), ['Codex sign-in', ['codex'], false, undefined], 'not signed in until Codex says so');
    signedIn = true;
    assert.equal((await a()).signedIn, true);
    signedIn = null;
    assert.equal((await a()).signedIn, null, 'Codex not installed: cannot tell');
    r = await go('/api/accounts/subscription/start', { mode: 'signin', name: 'chatgpt' });
    assert.match(r.json.error, /Codex's own sign-in/);
    await go('/api/accounts/chatgpt/delete', {});
  } finally {
    await app3.close();
  }
});

test('a sign-in provider with a Claude folder of its own is listed as such, without the folder', async () => {
  const { deleteProfile } = await import('../../src/profiles.mjs');
  const folder = path.join(box.root, 'own-claude-folder');
  writeProfile('own-folder', { label: 'Own folder', env: { CLAUDE_CONFIG_DIR: folder } });
  try {
    const r = await call('/api/accounts');
    const a = r.json.accounts.find((x) => x.name === 'own-folder');
    const w = r.json.accounts.find((x) => x.name === 'work');
    assert.deepEqual([a.kind, a.ownFolder, w.kind, w.ownFolder], ['login', true, 'login', undefined]);
    assert.ok(!JSON.stringify(r.json).includes(folder), 'the folder never reaches the page');
    const st = await call('/api/state');
    assert.equal(st.json.profiles.find((x) => x.name === 'own-folder').ownFolder, true, 'the state says the same');
  } finally {
    deleteProfile('own-folder');
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
