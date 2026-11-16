// Providers and coding tools: the new kinds (an OpenAI key, a Codex sign-in), the API= and TOOLS= lines, which tools
// a provider serves (a Claude subscription: Claude Code only, refused everywhere else), and what Codex and OpenCode
// get at start: a provider block and the key in one variable, never another provider's or the shell's variables.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-providers-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_PROFILES_DIR = path.join(tmp, 'profiles');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P = await import('../../src/profiles.mjs');
const T = await import('../../src/codetools/providers.mjs');

const KEY = 'gw-key-0123456789abcdef';
P.writeProfile('sub', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret-subscription' } });
P.writeProfile('login', {});
P.writeProfile('claudekey', { env: { ANTHROPIC_API_KEY: 'sk-ant-api-secret' } });
P.writeProfile('gw', { label: 'Gateway', api: ['models', 'messages', 'chat', 'responses', 'bogus'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/v1', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'm-big' } });
P.writeProfile('oai', { models: '*=gpt-x', env: { OPENAI_API_KEY: 'sk-openai-secret' } });
P.writeProfile('codexin', { signin: 'codex' });
P.writeProfile('narrow', { api: ['messages', 'responses'], tools: ['opencode'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } });

test('kinds, and the API= and TOOLS= lines read back in a fixed order, unknown words dropped', () => {
  const kinds = Object.fromEntries(P.listProfiles().map((p) => [p.name, p.kind]));
  assert.deepEqual(kinds, { claudekey: 'api', codexin: 'chatgpt', gw: 'api', login: 'login', narrow: 'api', oai: 'openai', sub: 'subscription' });
  const gw = P.readProfile('gw');
  assert.deepEqual(gw.api, ['messages', 'responses', 'chat', 'models']);
  assert.match(fs.readFileSync(path.join(process.env.HOPRIG_PROFILES_DIR, 'gw.env'), 'utf8'), /^API=messages,responses,chat,models$/m);
  assert.equal('API' in gw.env, false, 'the meta lines are not exported to a tool');
  assert.deepEqual(P.readProfile('narrow').tools, ['opencode']);
  assert.equal(P.readProfile('codexin').signin, 'codex');
  assert.equal(P.readProfile('codexin').label, 'Codex sign-in');
  assert.equal(P.readProfile('oai').paid, true, 'a key straight to OpenAI is pay-per-use');
  assert.equal(P.isPayPerUse({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://localhost:20017' }), false, 'through a gateway it is not');
  // Rewriting a provider with its own meta keeps every line (rename, new model, sign in again).
  P.writeProfile('gw', { ...P.metaOf(gw), label: 'Renamed', env: gw.env });
  assert.deepEqual(P.readProfile('gw').api, gw.api);
  assert.equal(P.readProfile('gw').label, 'Renamed');
});

test('which coding tools each provider serves; a Claude sign-in serves Claude Code only, whatever its file says', () => {
  const serves = Object.fromEntries(P.listProfiles().map((p) => [p.name, P.servesTools(p)]));
  assert.deepEqual(serves, {
    claudekey: ['claude', 'opencode'], codexin: ['codex'], gw: ['claude', 'codex', 'opencode'], login: ['claude'],
    narrow: ['opencode'], oai: ['codex', 'opencode'], sub: ['claude'],
  });
  // A subscription file with API= and TOOLS= lines still serves Claude Code only.
  P.writeProfile('sub2', { api: ['responses', 'chat'], tools: ['codex', 'opencode'], env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } });
  assert.deepEqual(P.servesTools(P.readProfile('sub2')), ['claude']);
  assert.deepEqual(P.servesTools({ name: 'auto', env: {} }), ['claude'], 'Auto mode and a profile built in code without a kind');
  // The page gets the list, never a value.
  const pub = P.publicProfile(P.readProfile('gw'));
  assert.deepEqual(pub.tools, ['claude', 'codex', 'opencode']);
  assert.ok(!JSON.stringify(P.listProfiles().map(P.publicProfile)).includes('secret'));
  assert.ok(!JSON.stringify(pub).includes(KEY));
  P.deleteProfile('sub2');
});

test('refused where a tool starts: Claude Code on an OpenAI key or a Codex sign-in; Codex and OpenCode on a subscription', () => {
  assert.throws(() => P.profileEnv(P.readProfile('oai')), /cannot be used for Claude Code: it does not answer/);
  assert.throws(() => P.profileEnv(P.readProfile('codexin')), /a Codex sign-in is for Codex only/);
  assert.throws(() => P.profileEnv(P.readProfile('narrow')), /cannot be used for Claude Code/);
  for (const tool of ['codex', 'opencode']) {
    for (const name of ['sub', 'login']) {
      assert.throws(() => T.toolEnv(tool, P.readProfile(name)), /a Claude subscription is for Claude Code only/, `${tool} on ${name}`);
    }
  }
  assert.throws(() => T.codexArgs(P.readProfile('sub')), /Claude subscription/);
  assert.throws(() => T.opencodeConfig(P.readProfile('sub')), /Claude subscription/);
  assert.throws(() => T.codexArgs(P.readProfile('claudekey')), /cannot be used for Codex/, 'Claude\'s API only: no Responses API');
  assert.throws(() => T.toolEnv('opencode', P.readProfile('codexin')), /Codex sign-in is for Codex only/);
  assert.equal(P.profileEnv(P.readProfile('gw')).ANTHROPIC_AUTH_TOKEN, KEY, 'a gateway that answers Claude\'s API still serves Claude Code');
});

test('no provider variable of the shell or of another tool reaches a tool', () => {
  const shell = { PATH: '/bin', ANTHROPIC_API_KEY: 'shell', ANTHROPIC_AUTH_TOKEN: 'shell', ANTHROPIC_BASE_URL: 'shell', ANTHROPIC_MODEL: 'shell', CLAUDE_CODE_OAUTH_TOKEN: 'shell', OPENAI_API_KEY: 'shell', OPENAI_BASE_URL: 'shell', CODEX_API_KEY: 'shell', HOPRIG_OPENCODE_KEY: 'shell' };
  const cx = T.toolEnv('codex', P.readProfile('gw'), shell);
  assert.deepEqual(Object.keys(cx).filter((k) => cx[k] !== undefined && k !== 'PATH').sort(), ['HOPRIG_CODEX_KEY', 'HOPRIG_PROFILE']);
  assert.equal(cx.HOPRIG_CODEX_KEY, KEY);
  const oc = T.toolEnv('opencode', P.readProfile('oai'), shell);
  assert.deepEqual(Object.keys(oc).filter((k) => k !== 'PATH').sort(), ['HOPRIG_OPENCODE_KEY', 'HOPRIG_PROFILE', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_FREE_MODELS']);
  assert.equal(oc.HOPRIG_OPENCODE_KEY, 'sk-openai-secret');
  const signin = T.toolEnv('codex', P.readProfile('codexin'), shell);
  assert.equal(signin.HOPRIG_CODEX_KEY, undefined, 'a Codex sign-in carries no key: Codex uses its own stored account');
  // Claude Code's side: an OpenAI key in the shell does not reach it either.
  const cl = P.profileEnv(P.readProfile('claudekey'), shell);
  for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(cl[k], undefined, k);
});

test('Codex: no self-update, then a model-provider block on the command line and the name of the key\'s variable', () => {
  const args = T.codexArgs(P.readProfile('gw'));
  assert.deepEqual(args.slice(0, 6), ['-c', 'check_for_update_on_startup=false', '-c', 'features.daemon_auto_start=false', '-c', 'features.in_app_updates=false']);
  assert.deepEqual(args.slice(6), [
    '-c', 'model_provider="hoprig"', '-c', 'model_providers.hoprig.name="Renamed"', '-c', 'model_providers.hoprig.base_url="http://127.0.0.1:9/v1"',
    '-c', 'model_providers.hoprig.env_key="HOPRIG_CODEX_KEY"', '-c', 'model_providers.hoprig.wire_api="responses"', '-c', 'model="m-big"',
  ]);
  assert.ok(!args.join(' ').includes(KEY), 'the key is never an argument');
  assert.deepEqual(T.codexArgs(P.readProfile('oai')).slice(8, 10), ['-c', 'model_providers.hoprig.name="OpenAI API"']);
  assert.ok(T.codexArgs(P.readProfile('oai')).includes('model_providers.hoprig.base_url="https://api.openai.com/v1"'));
  assert.deepEqual(T.codexArgs(P.readProfile('codexin')), ['-c', 'check_for_update_on_startup=false', '-c', 'features.daemon_auto_start=false', '-c', 'features.in_app_updates=false']);
  assert.equal(T.tomlString('a "b" \\ c\x7f'), '"a \\"b\\" \\\\ c\\u007f"');
});

test('OpenCode: a provider block in a file of Hoprig\'s own, with no secret in it; the models from the provider', async () => {
  const cfg = T.opencodeConfig(P.readProfile('gw'), ['m-small', 'bad id with spaces']);
  assert.equal(cfg.update, 'disable');
  assert.deepEqual(cfg.disabled_providers, ['opencode']);
  assert.deepEqual(cfg.providers.hoprig.settings, { baseURL: 'http://127.0.0.1:9/v1', apiKey: '{env:HOPRIG_OPENCODE_KEY}' });
  assert.equal(cfg.providers.hoprig.package, '@opencode/ai/providers/anthropic-compatible');
  assert.deepEqual(Object.keys(cfg.providers.hoprig.models), ['m-big', 'm-small']);
  assert.equal(cfg.model, 'hoprig/m-big');
  assert.equal(T.opencodeConfig(P.readProfile('oai')).providers.hoprig.package, '@opencode/ai/providers/openai-compatible');
  // A stand-in provider lists its models (Bearer for this one); the file is written to Hoprig's folder, 0600.
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization || '', req.headers['x-api-key'] || '']);
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm-big' }, { id: 'm-other' }, { id: 'no good' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const prof = { ...P.readProfile('gw'), env: { ...P.readProfile('gw').env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}` } };
    assert.deepEqual(await T.providerModels(prof), ['m-big', 'm-other']);
    const { args, env } = await T.startSettings('opencode', prof, { base: { PATH: '/bin' } });
    assert.deepEqual(args, []);
    assert.equal(env.OPENCODE_CONFIG, path.join(process.env.HOPRIG_STATE_DIR, 'codetools', 'opencode', 'gw.json'));
    const text = fs.readFileSync(env.OPENCODE_CONFIG, 'utf8');
    assert.ok(!text.includes(KEY), 'no secret in the file');
    assert.deepEqual(Object.keys(JSON.parse(text).providers.hoprig.models), ['m-big', 'm-other']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(env.OPENCODE_CONFIG).mode & 0o777, 0o600);
    assert.equal(env.HOPRIG_OPENCODE_KEY, KEY);
  } finally {
    srv.close();
  }
  assert.deepEqual(await T.providerModels({ ...P.readProfile('gw'), env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } }), [], 'unreachable: no models, no error');
  assert.deepEqual(await T.providerModels(P.readProfile('codexin')), [], 'a sign-in has no endpoint to ask');
});
