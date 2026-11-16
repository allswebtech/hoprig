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
process.env.CODEX_HOME = path.join(tmp, 'codex-home'); // never the owner's own Codex folder
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
  assert.throws(() => P.profileEnv(P.readProfile('codexin')), /it is the sign-in of another coding tool/);
  assert.throws(() => P.profileEnv(P.readProfile('narrow')), /cannot be used for Claude Code/);
  for (const tool of ['codex', 'opencode']) {
    for (const name of ['sub', 'login']) {
      assert.throws(() => T.toolEnv(tool, P.readProfile(name)), /a Claude subscription is for Claude Code only/, `${tool} on ${name}`);
    }
  }
  assert.throws(() => T.codexArgs(P.readProfile('sub')), /Claude subscription/);
  assert.throws(() => T.opencodeConfig(P.readProfile('sub')), /Claude subscription/);
  assert.throws(() => T.codexArgs(P.readProfile('claudekey')), /cannot be used for Codex/, 'Claude\'s API only: no Responses API');
  assert.throws(() => T.toolEnv('opencode', P.readProfile('codexin')), /it is the sign-in of another coding tool/);
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
  // Commands Codex runs for the model never see the key variable (checked on Codex 0.169 with `codex sandbox -- env`).
  assert.deepEqual(args.slice(6, 8), ['-c', 'shell_environment_policy.exclude=["HOPRIG_CODEX_KEY*", "HOPRIG_CODEX_WS*"]']);
  assert.deepEqual(args.slice(8), [
    '-c', 'model_provider="hoprig"', '-c', 'model_providers.hoprig.name="Renamed"', '-c', 'model_providers.hoprig.base_url="http://127.0.0.1:9/v1"',
    '-c', 'model_providers.hoprig.env_key="HOPRIG_CODEX_KEY"', '-c', 'model_providers.hoprig.wire_api="responses"', '-c', 'model="m-big"',
  ]);
  assert.ok(!args.join(' ').includes(KEY), 'the key is never an argument');
  assert.deepEqual(T.codexArgs(P.readProfile('oai')).slice(10, 12), ['-c', 'model_providers.hoprig.name="OpenAI API"']);
  assert.ok(T.codexArgs(P.readProfile('oai')).includes('model_providers.hoprig.base_url="https://api.openai.com/v1"'));
  assert.deepEqual(T.codexArgs(P.readProfile('codexin')), ['-c', 'check_for_update_on_startup=false', '-c', 'features.daemon_auto_start=false', '-c', 'features.in_app_updates=false', '-c', 'shell_environment_policy.exclude=["HOPRIG_CODEX_KEY*", "HOPRIG_CODEX_WS*"]', '-c', 'model_provider="openai"'], 'a Codex sign-in names Codex\'s own OpenAI provider, so its config cannot pick another');
  assert.equal(T.tomlString('a "b" \\ c\x7f'), '"a \\"b\\" \\\\ c\\u007f"');
});

test('Codex: the owner\'s own list of variables kept from commands stays; Hoprig\'s names are added to it', async () => {
  const S = await import('../../src/codetools/servers.mjs');
  const { ownerExcludes } = await import('../../src/codetools/codex.mjs');
  const { parseToml } = await import('../../src/codetools/toml.mjs');
  const home = path.join(tmp, 'owner-codex');
  fs.mkdirSync(home, { recursive: true });
  const write = (text) => fs.writeFileSync(path.join(home, 'config.toml'), text);
  const filterOf = (args) => args.find((a) => a.startsWith('shell_environment_policy.'));
  const OURS = '"HOPRIG_CODEX_KEY*", "HOPRIG_CODEX_WS*"';
  // A -c value replaces the list at its path, so the owner's list must be in it, for the terminal and the server.
  write([
    'model = "gpt-x" # a comment',
    'developer_instructions = """',
    '[shell_environment_policy]',
    'exclude = ["not a table"]',
    '"""',
    '[projects."/some/folder"]',
    'trust_level = "trusted"',
    '',
    '[shell_environment_policy]',
    'inherit = "all"',
    'exclude = [',
    '  "AWS_*",   # cloud',
    "  'GITHUB_TOKEN',",
    '  "HOPRIG_CODEX_KEY*",',
    ']',
    '[shell_environment_policy.set]',
    'X = "1"',
  ].join('\n'));
  assert.deepEqual(ownerExcludes(home), ['AWS_*', 'GITHUB_TOKEN', 'HOPRIG_CODEX_KEY*']);
  const want = `shell_environment_policy.exclude=["AWS_*", "GITHUB_TOKEN", ${OURS}]`;
  assert.equal(filterOf(T.codexArgs(P.readProfile('gw'), { home })), want, 'the standalone start');
  assert.equal(filterOf(S.codexServerArgs(S.serverProviders('codex', P.listProfiles()), { port: 5, tokenFile: '/t', home })), want, 'the app server');
  // The other ways TOML can say the same.
  write('shell_environment_policy.exclude = ["A_*"]\n[other]\nexclude = ["NOT_THIS"]\n');
  assert.deepEqual(ownerExcludes(home), ['A_*']);
  write('shell_environment_policy = { inherit = "core", exclude = ["B_*", "C"] }\n');
  assert.deepEqual(ownerExcludes(home), ['B_*', 'C']);
  // No list, no file, or a file this reader cannot read: Hoprig's names only.
  write('[shell_environment_policy]\ninherit = "all"\n');
  assert.equal(filterOf(T.codexArgs(P.readProfile('gw'), { home })), `shell_environment_policy.exclude=[${OURS}]`);
  write('[shell_environment_policy\nexclude = ["A"]\n');
  assert.deepEqual(ownerExcludes(home), []);
  fs.rmSync(path.join(home, 'config.toml'));
  assert.deepEqual(ownerExcludes(home), []);
  // An owner's pattern with a quote or a backslash is written back as TOML reads it.
  write('[shell_environment_policy]\nexclude = [\'A"B\', "C\\\\D"]\n');
  assert.deepEqual(ownerExcludes(home), ['A"B', 'C\\D']);
  assert.equal(filterOf(T.codexArgs(P.readProfile('gw'), { home })), `shell_environment_policy.exclude=["A\\"B", "C\\\\D", ${OURS}]`);
  assert.deepEqual(parseToml('a = \'x\'\nb.c = [1, true, "s", { d = \'e\' }]\n[[t]]\nk = 1\n[[t]]\nk = 2\n'), { a: 'x', b: { c: [1, true, 's', { d: 'e' }] }, t: [{ k: 1 }, { k: 2 }] });
  assert.throws(() => parseToml('a = 1\na = 2\n'), /twice/);
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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm-big' }, { id: 'm-other' }, { id: 'no good' }, { id: '--auto' }] })); // "--auto" would be read as an option
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
    assert.equal(JSON.parse(text).agents, undefined, 'OpenCode\'s own rules unless "ask" was chosen');
    // "ask" without Hoprig's server: the working agents get the rules (a global rule would lose to "build"'s own).
    const ask = await T.startSettings('opencode', prof, { base: { PATH: '/bin' }, permissionMode: 'ask' });
    assert.equal(ask.env.OPENCODE_CONFIG, path.join(process.env.HOPRIG_STATE_DIR, 'codetools', 'opencode', 'gw.ask.json'), 'a file of its own: sessions in other modes keep theirs');
    const agents = JSON.parse(fs.readFileSync(ask.env.OPENCODE_CONFIG, 'utf8')).agents;
    assert.deepEqual(Object.keys(agents), ['build', 'general']);
    assert.deepEqual(agents.build.permissions.map((r) => `${r.action}:${r.effect}`), ['edit:ask', 'shell:ask', 'webfetch:ask', 'external_directory:ask']);
  } finally {
    srv.close();
  }
  assert.deepEqual(await T.providerModels({ ...P.readProfile('gw'), env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } }), [], 'unreachable: no models, no error');
  assert.deepEqual(await T.providerModels(P.readProfile('codexin')), [], 'a sign-in has no endpoint to ask');
});
