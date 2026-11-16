// Terminal sessions of Codex and OpenCode: the launcher's words and the command lines it builds, the status read
// from each tool's server, the one server per tool (started on demand by a helper, stopped when unused), the
// conversation lists from each tool's own store, and the coding-card helper. The real tools were proven by hand
// with a few short turns; here stand-in programs play the servers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-terminal-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_PROFILES_DIR = path.join(tmp, 'profiles');
process.env.HOPRIG_TOOLS_DIR = path.join(tmp, 'tools');
process.env.CODEX_HOME = path.join(tmp, 'codex-home');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P = await import('../../src/profiles.mjs');
const T = await import('../../src/codetools/terminal.mjs');
const S = await import('../../src/codetools/servers.mjs');
const ST = await import('../../src/codetools/stores.mjs');
const C = await import('../../src/automation/cards.mjs');
const { launchArgv, Deck } = await import('../../src/server/deck.mjs');
const { toolFlags, toolFromRequest } = await import('../../src/codetools/start.mjs');

const KEY = 'gw-key-terminal-0123456789';
P.writeProfile('gw', { label: 'Gateway', api: ['messages', 'responses', 'chat'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/v1', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'm-small' } });
P.writeProfile('my-gw', { label: 'Second', api: ['messages', 'responses'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: `${KEY}-2` } });
P.writeProfile('sub', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret-subscription' } });
P.writeProfile('codexin', { signin: 'codex' });

test('the launcher\'s words for Codex and OpenCode, and what moves with a session', () => {
  const o = T.parseToolArgs(['--permission-mode', 'readOnly', '--effort=high', '-c', '--model', 'm1', '--foo', '--', '-starts', 'with a dash']);
  assert.deepEqual(o, { resume: null, cont: true, permissionMode: 'readOnly', effort: 'high', model: 'm1', prompt: '-starts with a dash', extra: ['--foo'] });
  assert.deepEqual(T.carryOf(o), ['--permission-mode', 'readOnly', '--effort', 'high', '--model', 'm1']);
  assert.equal(T.parseToolArgs(['--resume', 'abc']).resume, 'abc');
  assert.throws(() => T.parseToolArgs(['--resume']), /needs a value/);
});

test('Codex in a terminal attaches to the server by token variable and names its provider; no key on its command line', () => {
  const [prov] = S.serverProviders('codex', [P.readProfile('gw')]);
  assert.match(prov.id, /^hoprig_gw_[0-9a-f]{6}$/);
  assert.match(prov.keyVar, /^HOPRIG_CODEX_KEY_GW_[0-9A-F]{6}$/);
  const o = T.parseToolArgs(['--permission-mode', 'bypassPermissions', '--effort', 'low', '--', '-x']);
  const args = T.codexTuiArgs({ port: 4567, prov, model: 'm-small', cwd: '/w', resume: '01a1e390-0000-7000-8000-000000000001', o });
  assert.deepEqual(args.slice(0, 4), ['--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'HOPRIG_CODEX_WS']);
  for (const a of ['check_for_update_on_startup=false', 'features.daemon_auto_start=false', `model_provider="${prov.id}"`, '--dangerously-bypass-approvals-and-sandbox', 'model_reasoning_effort="low"']) assert.ok(args.includes(a), a);
  assert.ok(args.includes(`model_providers.${prov.id}.env_key="${prov.keyVar}"`));
  assert.deepEqual(args.slice(-5), ['/w', 'resume', '01a1e390-0000-7000-8000-000000000001', '--', '-x'], 'a prompt that starts with "-" is not read as a flag');
  assert.equal(args.join(' ').includes(KEY), false, 'the key is never on a command line');
  // A Codex sign-in is Codex's own "openai" provider: no block at all.
  const [signin] = S.serverProviders('codex', [P.readProfile('codexin')]);
  assert.deepEqual([signin.id, signin.keyVar], ['openai', null]);
  const signinArgs = T.codexTuiArgs({ port: 1, prov: signin, model: null, cwd: '/w', o: T.parseToolArgs([]) });
  assert.ok(signinArgs.includes('model_provider="openai"'), 'a session on the Codex sign-in names it: the server\'s default is a key provider');
  assert.equal(signinArgs.some((a) => a.startsWith('model_providers.')), false, 'and needs no block');
  assert.throws(() => T.codexTuiArgs({ port: 1, prov, cwd: '/w', o: T.parseToolArgs(['--permission-mode', 'yolo']) }), /permission mode is one of/);
});

test('OpenCode in a terminal attaches to the server on one conversation; "ask" adds rules, bypass is its --auto', async () => {
  const { opencode } = await import('../../src/codetools/opencode.mjs');
  const args = T.opencodeTuiArgs({ url: 'http://127.0.0.1:9', id: 'ses_abcdefgh12345678', cwd: '/w', o: T.parseToolArgs(['--permission-mode', 'bypassPermissions', '--', 'hi']) });
  assert.deepEqual(args, ['--server', 'http://127.0.0.1:9', '-s', 'ses_abcdefgh12345678', '--auto', '--prompt=hi', '/w']);
  // A first message that starts with "-" stays one argument: OpenCode would read `--prompt --auto` as its own option.
  const dash = T.opencodeTuiArgs({ url: 'u', id: 'ses_abcdefgh12345678', cwd: '/w', o: T.parseToolArgs(['--permission-mode', 'ask', '--', '--auto']) });
  assert.deepEqual(dash, ['--server', 'u', '-s', 'ses_abcdefgh12345678', '--prompt=--auto', '/w']);
  assert.equal(dash.includes('--auto'), false, 'an "ask" session never gets --auto from its message');
  assert.deepEqual(opencode.sessionPermissions({ permissionMode: 'ask' }).permissions.map((r) => [r.action, r.effect]), [['edit', 'ask'], ['shell', 'ask'], ['webfetch', 'ask'], ['external_directory', 'ask']]);
  assert.deepEqual(opencode.sessionPermissions({}), {});
  assert.throws(() => opencode.flagsFor({ effort: 'ultra' }), /effort is one of/);
});

test('OpenCode: a conversation continued in "ask" mode asks from then on; in another mode it stops asking; without a mode it stays', async () => {
  const http = await import('node:http');
  const { opencodePlan } = await import('../../src/codetools/attach.mjs');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push([req.method, req.url, body ? JSON.parse(body) : null]);
      if (req.method === 'PATCH') { res.writeHead(204); return res.end(); }
      res.writeHead(200);
      res.end(JSON.stringify({ data: { id: 'ses_abcdefgh12345678', title: 'T', permissions: [] } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const server = { port: srv.address().port, secret: 's' };
  const plan = (args) => opencodePlan(server, { profile: P.readProfile('gw'), model: null, cwd: tmp, o: T.parseToolArgs(['--resume', 'ses_abcdefgh12345678', ...args]), base: {}, report: Object.assign(() => {}, { title: () => {} }) });
  const patches = () => seen.filter(([m]) => m === 'PATCH').map(([, url, b]) => [url, b.permissions.map((r) => `${r.action}:${r.effect}`)]);
  try {
    await plan(['--permission-mode', 'ask']);
    assert.deepEqual(patches(), [['/api/session/ses_abcdefgh12345678', ['edit:ask', 'shell:ask', 'webfetch:ask', 'external_directory:ask']]]);
    seen.length = 0;
    await plan(['--permission-mode', 'default']);
    assert.deepEqual(patches(), [['/api/session/ses_abcdefgh12345678', []]], 'another mode takes the "ask" rules away');
    seen.length = 0;
    await plan([]);
    assert.deepEqual(patches(), [], 'no mode chosen: the conversation keeps its rules');
  } finally {
    srv.close();
  }
});

test('status from the servers\' events: working, needs your OK, waiting; an error is kept until the next turn', () => {
  // Codex's finished items: the model's message, and the owner's first words as a title (its threads have no name).
  const got = [];
  const to = { message: (t) => got.push(['message', t]), title: (t) => got.push(['title', t]) };
  T.codexItem({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Fix the\n login page', text_elements: [] }, { type: 'image', url: 'x' }] }, to);
  T.codexItem({ type: 'agentMessage', id: 'm', text: ' DONE ' }, to);
  T.codexItem({ type: 'agentMessage', id: 'm', text: '  ' }, to);
  T.codexItem({ type: 'commandExecution', id: 'c' }, to);
  T.codexItem(null, to);
  assert.deepEqual(got, [['title', 'Fix the login page'], ['message', 'DONE']]);
  assert.deepEqual(T.codexStatus({ type: 'active', activeFlags: [] }), { status: 'working' });
  assert.equal(T.codexStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }).status, 'attention');
  assert.equal(T.codexStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }).status, 'attention');
  assert.deepEqual(T.codexStatus({ type: 'idle' }), { status: 'waiting' });
  assert.deepEqual(T.codexStatus({ type: 'systemError' }), { status: 'waiting', failed: true });
  assert.equal(T.codexStatus({ type: 'notLoaded' }), null);
  assert.equal(T.opencodeStatus('session.execution.started').status, 'working');
  assert.match(T.opencodeStatus('permission.asked', { action: 'shell', resources: ['printf ok > d.txt'] }).note, /shell printf ok > d\.txt/);
  assert.equal(T.opencodeStatus('permission.replied').status, 'working');
  assert.equal(T.opencodeStatus('session.execution.interrupted').status, 'waiting');
  assert.equal(T.opencodeStatus('session.text.delta'), null);
  const end = T.statusPatch('working', T.opencodeStatus('session.execution.failed', { error: { message: 'boom' } }), 1000);
  assert.deepEqual(end, { status: 'waiting', note: '', stopAt: 1000, failure: { at: 1000, error: 'error', text: 'boom' } });
  assert.deepEqual(T.statusPatch('waiting', { status: 'working' }, 5), { status: 'working', note: '', failure: null });
});

test('the servers\' providers: every provider that serves the tool, keys only in the server\'s environment', () => {
  const all = P.listProfiles();
  assert.deepEqual(S.serverProviders('codex', all).map((p) => p.name), ['codexin', 'gw', 'my-gw']);
  assert.deepEqual(S.serverProviders('opencode', all).map((p) => p.name), ['gw', 'my-gw'], 'a subscription and a Codex sign-in never');
  const provs = S.serverProviders('codex', all);
  const args = S.codexServerArgs(provs, { port: 5, tokenFile: '/t' });
  assert.equal(args.join(' ').includes(KEY), false);
  assert.ok(args.includes(`model_provider="${S.providerId('gw')}"`), 'the default is a Hoprig provider, not OpenAI\'s account');
  assert.deepEqual(args.slice(-6), ['--listen', 'ws://127.0.0.1:5', '--ws-auth', 'capability-token', '--ws-token-file', '/t']);
  for (const a of ['check_for_update_on_startup=false', 'features.daemon_auto_start=false', 'features.in_app_updates=false']) assert.ok(args.includes(a), `the server never updates itself either: ${a}`);
  assert.ok(args.includes('shell_environment_policy.exclude=["HOPRIG_CODEX_KEY*", "HOPRIG_CODEX_WS*"]'), 'commands the server runs for a model never see the keys');
  const env = S.serverEnv('codex', provs, { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'shell-secret', OPENAI_API_KEY: 'shell-openai', HOPRIG_CODEX_KEY: 'old', OPENCODE_PASSWORD: 'pw' });
  assert.equal(env[S.keyVarOf('codex', 'gw')], KEY);
  assert.equal(env[S.keyVarOf('codex', 'my-gw')], `${KEY}-2`);
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'HOPRIG_CODEX_KEY', 'OPENCODE_PASSWORD']) assert.equal(k in env, false, k);
  const cfg = S.opencodeServerConfig(S.serverProviders('opencode', all), (p) => (p.name === 'gw' ? ['m-big'] : []));
  assert.equal(JSON.stringify(cfg).includes(KEY), false, 'OpenCode\'s config names the variable, never the key');
  assert.deepEqual(Object.keys(cfg.providers[S.providerId('gw')].models), ['m-small', 'm-big']);
  assert.equal(cfg.providers[S.providerId('gw')].settings.apiKey, `{env:${S.keyVarOf('opencode', 'gw')}}`);
  assert.deepEqual(cfg.disabled_providers, ['opencode']);
  assert.notEqual(S.providerId('a-b'), S.providerId('a_b'), 'names that look alike stay apart');
});

// ---- a stand-in Codex: an "app server" that answers its readiness route on the port it is given ----
function installFake(tool, body) {
  const bin = path.join(process.env.HOPRIG_TOOLS_DIR, tool, 'node_modules', '.bin', tool);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return bin;
}
const FAKE_SERVER = `
const http = require('node:http'); const fs = require('node:fs');
const a = process.argv.slice(2);
const listen = a[a.indexOf('--listen') + 1] || '';
const port = Number(listen.split(':').pop()) || Number(a[a.indexOf('--port') + 1]);
fs.writeFileSync(process.env.HOPRIG_TEST_SEEN, JSON.stringify({ args: a, envNames: Object.keys(process.env), keyOk: Object.values(process.env).includes(process.env.HOPRIG_TEST_WANT), ppid: process.ppid }));
http.createServer((req, res) => {
  const pw = process.env.OPENCODE_PASSWORD;
  if (pw && req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + pw).toString('base64')) { res.writeHead(401); return res.end(); }
  res.writeHead(200); res.end('{}');
}).listen(port, '127.0.0.1');
`;

test('one server per tool: started by a helper (nobody\'s child), reused, refused for a provider added while in use, stopped when unused', async () => {
  installFake('codex', FAKE_SERVER);
  process.env.HOPRIG_TEST_SEEN = path.join(tmp, 'seen.json');
  process.env.HOPRIG_TEST_WANT = KEY;
  const r = await S.ensureServer('codex', { need: 'gw' });
  assert.equal(r.ok, true, r.why);
  const seen = JSON.parse(fs.readFileSync(process.env.HOPRIG_TEST_SEEN, 'utf8'));
  assert.equal(seen.keyOk, true, 'the server has the provider\'s key');
  assert.notEqual(seen.ppid, process.pid, 'the server is not a child of whoever asked for it');
  assert.equal(seen.args.join(' ').includes(KEY), false);
  assert.equal(fs.statSync(path.join(S.serverDir(), 'codex-server.secret')).mode & 0o077, 0, 'the token file is private');
  const again = await S.ensureServer('codex', { need: 'my-gw' });
  assert.equal(again.server.pid, r.server.pid, 'the running server is reused');

  // A provider added after the start while a session uses the server: that server is kept, the caller is told.
  P.writeProfile('late', { api: ['responses'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'late-key-0000000000' } });
  const runsDir = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runFile = path.join(runsDir, 'user.json');
  fs.writeFileSync(runFile, JSON.stringify({ runId: 'user', pid: process.pid, tool: 'codex', server: true, profile: 'gw', cwd: '/w', status: 'waiting', startedAt: 1, statusAt: 1 }));
  const late = await S.ensureServer('codex', { need: 'late' });
  assert.equal(late.ok, false);
  assert.match(late.why, /other sessions use it/);
  assert.equal(await S.stopIfUnused('codex'), false, 'a session uses it');
  fs.rmSync(runFile);
  // Unused: started anew with the new provider.
  const fresh = await S.ensureServer('codex', { need: 'late' });
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.server.pid, r.server.pid);
  assert.equal(await S.stopIfUnused('codex', { idleMs: 60_000 }), false, 'just used: kept for a while');
  assert.equal(await S.stopIfUnused('codex'), true);
  assert.equal(S.readServer('codex'), null);
  assert.throws(() => process.kill(fresh.server.pid, 0), 'the process is gone');
  P.deleteProfile('late');
});

test('OpenCode\'s server always has a password, and a lock left by a holder that died does not block', async () => {
  installFake('opencode', FAKE_SERVER);
  const lock = path.join(S.serverDir(), 'opencode-server.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), '999999999');
  const r = await S.ensureServer('opencode', { fetchImpl: async (url, o) => (String(url).includes('/v1/models') ? new Response('{"data":[]}') : fetch(url, o)) });
  assert.equal(r.ok, true, r.why);
  assert.equal((await fetch(`http://127.0.0.1:${r.server.port}/api/info`)).status, 401, 'nothing without the password');
  const seen = JSON.parse(fs.readFileSync(process.env.HOPRIG_TEST_SEEN, 'utf8'));
  assert.ok(seen.envNames.includes('OPENCODE_PASSWORD') && seen.envNames.includes('OPENCODE_CONFIG'));
  assert.ok(seen.envNames.includes('OPENCODE_DISABLE_AUTOUPDATE'));
  assert.deepEqual(seen.args.slice(0, 3), ['serve', '--hostname', '127.0.0.1']);
  await S.stopServer('opencode');
  assert.equal(S.readServer('opencode'), null);
});

test('a server that answers late is never stopped under the chats that hold it; a slow one nobody uses starts again', async () => {
  installFake('opencode', FAKE_SERVER);
  const models = (url, o) => (String(url).includes('/v1/models') ? new Response('{"data":[]}') : fetch(url, o));
  const first = await S.ensureServer('opencode', { fetchImpl: models });
  assert.equal(first.ok, true, first.why);
  // Its info route does not answer in time (a busy server): asked again, then refused, never restarted.
  let asked = 0;
  const slow = async (url, o) => {
    if (String(url).endsWith('/api/info')) {
      asked++;
      throw new Error('timed out');
    }
    return models(url, o);
  };
  const release = S.holdServer('opencode');
  const held = await S.ensureServer('opencode', { fetchImpl: slow });
  assert.equal(held.ok, false);
  assert.match(held.why, /does not answer just now/);
  assert.ok(asked >= 2, 'asked again before giving up');
  assert.equal(S.readServer('opencode').pid, first.server.pid, 'the same server');
  assert.doesNotThrow(() => process.kill(first.server.pid, 0), 'still running under the chat');
  release();
  // Nobody holds it: a server that does not answer is started anew.
  const fresh = await S.ensureServer('opencode', { fetchImpl: async (url, o) => (String(url).includes(`:${first.server.port}/api/info`) ? slow(url, o) : models(url, o)) });
  assert.equal(fresh.ok, true, fresh.why);
  assert.notEqual(fresh.server.pid, first.server.pid);
  await S.stopServer('opencode');
});

test('Codex\'s conversations of a folder come from its own store, with the name it gave them', async () => {
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '16');
  fs.mkdirSync(day, { recursive: true });
  const line = (id, cwd) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, originator: 'x' } });
  const user = (t) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });
  const a = '01a1e390-0000-7000-8000-000000000001';
  const b = '01a1e390-0000-7000-8000-000000000002';
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T14-00-00-${a}.jsonl`), [line(a, '/w/proj'), user('<environment_context>'), user('Fix the build please')].join('\n') + '\n');
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T14-05-00-${b}.jsonl`), [line(b, '/w/other'), user('elsewhere')].join('\n') + '\n');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), `${JSON.stringify({ id: a, thread_name: 'old' })}\n${JSON.stringify({ id: a, thread_name: 'Build fix' })}\n`);
  assert.deepEqual((await ST.codexSessions('/w/proj')).map((s) => [s.id, s.title]), [[a, 'Build fix']]);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), '');
  assert.deepEqual((await ST.codexSessions('/w/proj')).map((s) => s.title), ['Fix the build please'], 'else its first message');
  assert.ok(ST.codexSessions('/w/proj') instanceof Promise, 'read without blocking the dashboard');
  assert.equal(ST.codexHas(a), true);
  assert.equal(ST.codexHas('01a1e399-0000-7000-8000-000000000000'), false, 'a thread nobody typed into has no file');
  assert.equal(ST.isToolSessionId('opencode', 'ses_0000demo0002SampleSession'), true);
  assert.equal(ST.isToolSessionId('opencode', '../etc'), false);
});

test('the launcher command: Claude Code\'s unchanged, Codex and OpenCode with a leading word; a move stays in its tool', () => {
  const L = ['node', 'hoprig'];
  const p = { name: 'gw', env: {} };
  assert.deepEqual(launchArgv(L, { profile: p, mode: 'resume', sessionId: 'id1', prompt: 'hi' }), ['node', 'hoprig', 'gw', '--resume', 'id1', '--', 'hi']);
  assert.deepEqual(launchArgv(L, { tool: 'codex', profile: p, mode: 'new', flags: ['--effort', 'low'], prompt: 'a\nb' }), ['node', 'hoprig', 'codex', 'gw', '--effort', 'low', '--', 'a b']);
  assert.deepEqual(launchArgv(L, { tool: 'opencode', profile: p, mode: 'continue' }), ['node', 'hoprig', 'opencode', 'gw', '-c']);
  assert.deepEqual(launchArgv(L, { tool: 'codex', profile: p, mode: 'move', sessionId: 'id1', carryArgs: ['--model', 'm'] }), ['node', 'hoprig', 'codex', 'gw', '--model', 'm', '--resume', 'id1']);
  assert.deepEqual(launchArgv(L, { tool: 'codex', profile: p, mode: 'move', sessionId: 'id1', fresh: true }), ['node', 'hoprig', 'codex', 'gw'], 'nothing to resume: a new one');
});

test('cards: a coding session of any tool, its tool, and a move refused to a provider that does not serve it', async () => {
  const runs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const now = Date.now();
  const rec = (runId, termId, extra) => fs.writeFileSync(path.join(runs, `${runId}.json`), JSON.stringify({ runId, pid: process.pid, profile: 'gw', cwd: '/w', termId, tmuxPane: null, status: 'working', statusAt: now - 50_000, startedAt: now - 60_000, carryArgs: ['--effort', 'low'], ...extra }));
  rec('r1', 'pty-aaaaaaaaaaaa', { tool: 'codex', server: true, statusSource: 'server', sessionId: '01a1e390-0000-7000-8000-000000000001', title: 'Build fix' });
  rec('r2', 'pty-bbbbbbbbbbbb', { tool: 'opencode', server: false, statusSource: 'basic', sessionId: 'ses_abcdefgh12345678' });
  const terms = [
    { id: 'pty-aaaaaaaaaaaa', session: 'one', cwd: '/w', pid: 1, activity: now - 30_000 },
    { id: 'pty-bbbbbbbbbbbb', session: 'two', cwd: '/w', pid: 2, activity: now - 30_000 },
  ];
  const respawned = [];
  const backend = { list: async () => terms, capture: async () => 'You\'ve hit your limit · resets 3pm', respawn: async (id, dir, argv) => respawned.push(argv) };
  const deck = new Deck({ backend, config: () => ({ launcher: ['hop'] }), profiles: () => P.listProfiles(), now: () => now });
  const cards = await deck.list();
  const one = cards.find((c) => c.name === 'one');
  const two = cards.find((c) => c.name === 'two');
  assert.deepEqual([one.kind, one.tool, one.status, one.title, one.limit, one.liveStatus], ['claude', 'codex', 'working', 'Build fix', null, undefined], 'its status from the server, no Claude wording read off its screen');
  assert.deepEqual([two.tool, two.status, two.liveStatus], ['opencode', 'waiting', 'basic'], 'basic: a quiet screen is waiting');
  assert.ok(C.isCodingCard(one) && !C.isClaudeCard(one) && C.toolOf(one) === 'codex');
  assert.ok(C.isClaudeCard({ kind: 'claude' }), 'an older card without a tool is Claude Code\'s');
  assert.equal(C.isCodingCard({ kind: 'shell' }) || C.isCodingCard({ kind: 'chat' }), false);
  assert.equal(C.busy(one), true, 'a working Codex session is busy: nothing is typed into it, nothing updated under it');

  const found = await deck.find('one');
  await assert.rejects(deck.move(found.term, found.run, 'sub'), /cannot be used for Codex: a Claude subscription is for Claude Code only/);
  await deck.move(found.term, found.run, 'my-gw');
  assert.deepEqual(respawned.pop(), ['hop', 'codex', 'my-gw', '--effort', 'low', '--resume', '01a1e390-0000-7000-8000-000000000001']);
});

test('a session\'s choices are the tool\'s own lists; the tool is named or Claude Code', () => {
  assert.deepEqual(toolFlags('codex', { permissionMode: 'readOnly', effort: 'xhigh', model: 'claude-haiku-5-5' }), ['--permission-mode', 'readOnly', '--effort', 'xhigh', '--model', 'claude-haiku-5-5']);
  assert.throws(() => toolFlags('codex', { permissionMode: 'acceptEdits' }), /one of: default, readOnly, bypassPermissions/);
  assert.throws(() => toolFlags('opencode', { effort: 'ultra' }), /one of: low, medium, high, xhigh, max/);
  assert.throws(() => toolFlags('opencode', { model: 'a b' }), /model id/);
  assert.throws(() => toolFlags('codex', { model: '--x' }), /model id/, 'a model id never starts with a dash: the tool would read it as an option');
  assert.equal(toolFromRequest(undefined), 'claude');
  assert.throws(() => toolFromRequest('vim'), /claude, codex, opencode/);
});

test('doctor names a provider file that a new command word hides, and says how to rename it', async () => {
  const K = await import('../../src/setup/checks.mjs');
  fs.writeFileSync(path.join(process.env.HOPRIG_PROFILES_DIR, 'codex.env'), 'ANTHROPIC_AUTH_TOKEN=x\n', { mode: 0o600 });
  assert.deepEqual(P.hiddenProfiles(), ['codex']);
  assert.equal(P.listProfiles().some((p) => p.name === 'codex'), false);
  const r = K.profilesCheck(P.listProfiles(), P.hiddenProfiles());
  assert.equal(r.status, 'warn');
  assert.match(r.detail || r.message || JSON.stringify(r), /"codex" is a command word now/);
  assert.match(JSON.stringify(r), /codex-provider\.env/);
  fs.rmSync(path.join(process.env.HOPRIG_PROFILES_DIR, 'codex.env'));
});

test('a session with basic live status sends no notification when its screen goes quiet', async () => {
  const { transitions } = await import('../../src/server/watcher.mjs');
  const card = (status, extra = {}) => ({ name: 'x', kind: 'claude', tool: 'codex', status, ...extra });
  let r = transitions(new Map(), [card('working', { liveStatus: 'basic' })]);
  r = transitions(r.next, [card('waiting', { liveStatus: 'basic' })]);
  assert.deepEqual(r.events, []);
  r = transitions(new Map([['x', 'working']]), [card('attention')]);
  assert.deepEqual(r.events.map((e) => e.status), ['attention'], 'from the server: told as for Claude Code');
});

test('a state file left by a server that died: the process that has its pid now is never stopped, only the files go', { skip: process.platform === 'win32' && 'no sleep program' }, async () => {
  const { spawn } = await import('node:child_process');
  const runs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.rmSync(runs, { recursive: true, force: true }); // no session uses the server
  process.env.HOPRIG_TEST_SEEN = path.join(tmp, 'seen.json');
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((r) => other.once('spawn', r));
  try {
    fs.mkdirSync(S.serverDir(), { recursive: true });
    fs.writeFileSync(path.join(S.serverDir(), 'codex-server.json'), JSON.stringify({ tool: 'codex', pid: other.pid, port: 1, providers: [], startedAt: 1, usedAt: 1 }));
    fs.writeFileSync(path.join(S.serverDir(), 'codex-server.secret'), 'x', { mode: 0o600 });
    assert.equal(await S.isServerProcess('codex', S.readServer('codex')), false, 'its command line does not say it listens there');
    assert.equal(await S.stopIfUnused('codex', { idleMs: 120_000 }), true);
    assert.equal(S.readServer('codex'), null, 'the files are gone');
    assert.doesNotThrow(() => process.kill(other.pid, 0), 'the other process lives');
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
    // The same through a start: a new server is started, the other process is left alone.
    fs.writeFileSync(path.join(S.serverDir(), 'codex-server.json'), JSON.stringify({ tool: 'codex', pid: other.pid, port: 1, providers: [] }));
    fs.writeFileSync(path.join(S.serverDir(), 'codex-server.secret'), 'x', { mode: 0o600 });
    installFake('codex', FAKE_SERVER);
    const r = await S.ensureServer('codex', { need: 'gw' });
    assert.equal(r.ok, true, r.why);
    assert.notEqual(r.server.pid, other.pid);
    assert.equal(other.signalCode, null);
    assert.equal(await S.isServerProcess('codex', S.readServer('codex')), true, 'the server it started is known by its command line');
    await S.stopServer('codex');
  } finally {
    other.kill();
  }
});

// A stand-in OpenCode: `serve` is its server (password, a conversation made by the API, an event stream); any other
// start is its screen, which ends at once. Every start of the server is counted.
const FAKE_OC = `
const http = require('node:http'); const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] !== 'serve') process.exit(0);
fs.appendFileSync(process.env.HOPRIG_TEST_STARTS, 'start\\n');
const port = Number(a[a.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')) { res.writeHead(401); return res.end(); }
  if (req.url === '/api/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': hi\\n\\n'); }
  if (req.method === 'POST' && req.url === '/api/session') { res.writeHead(200); return res.end(JSON.stringify({ data: { id: 'ses_abcdefgh12345678' } })); }
  res.writeHead(200); res.end('{}');
}).listen(port, '127.0.0.1');
`;

test('a new session on a provider the running server lacks: when nobody else uses it, the server starts again with it', async () => {
  installFake('opencode', FAKE_OC);
  process.env.HOPRIG_TEST_STARTS = path.join(tmp, 'oc-starts.txt');
  fs.writeFileSync(process.env.HOPRIG_TEST_STARTS, '');
  const quiet = { fetchImpl: async (url, o) => (String(url).includes('/v1/models') ? new Response('{"data":[]}') : fetch(url, o)) };
  const first = await S.ensureServer('opencode', { need: 'gw', ...quiet });
  assert.equal(first.ok, true, first.why);
  P.writeProfile('late2', { api: ['messages'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'late2-key-000000000', ANTHROPIC_MODEL: 'm' } });
  const said = [];
  const err = console.error;
  console.error = (...x) => said.push(x.join(' '));
  let code;
  try {
    code = await T.launchTool('opencode', 'late2', [], { cwd: tmp });
  } finally {
    console.error = err;
  }
  assert.equal(code, 0, said.join('\n'));
  assert.ok(!said.join('\n').includes('runs on its own'), `its own run did not keep the old server: ${said.join(' | ')}`);
  assert.equal(fs.readFileSync(process.env.HOPRIG_TEST_STARTS, 'utf8').split('\n').filter(Boolean).length, 2, 'started again, with the new provider');
  assert.equal(S.readServer('opencode'), null, 'and stopped when that last session ended');
  P.deleteProfile('late2');
});

test('Codex: a new session claims only a new thread of its folder, never a subagent\'s or a copy made for a move', async () => {
  const A = await import('../../src/codetools/attach.mjs');
  assert.equal(A.isNewThreadOf({ id: 't1', cwd: tmp }, tmp), true);
  assert.equal(A.isNewThreadOf({ id: 't2', cwd: tmp, forkedFromId: 't1' }, tmp), false, 'thread/fork announces its copy with forkedFromId');
  assert.equal(A.isNewThreadOf({ id: 't3', cwd: tmp, parentThreadId: 't1' }, tmp), false);
  assert.equal(A.isNewThreadOf({ id: 't4', cwd: tmp, ephemeral: true }, tmp), false);
  assert.equal(A.isNewThreadOf({ id: 't5', cwd: '/elsewhere' }, tmp), false);
});

test('Codex asks on its screen whether to trust a new folder before its thread exists: the card needs your OK', async () => {
  const { codexScreenQuestion } = await import('../../src/codetools/codex.mjs');
  const trust = '  Folder access\n  /w/proj\n  Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n  2. Back';
  assert.match(codexScreenQuestion(trust), /trust this folder/);
  assert.match(codexScreenQuestion('3 hooks are new or changed\n 1. Trust all and continue'), /trust new hooks/);
  assert.equal(codexScreenQuestion('› Ask Codex to do anything'), null);
  const runs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.rmSync(runs, { recursive: true, force: true });
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'r9.json'), JSON.stringify({ runId: 'r9', pid: process.pid, profile: 'gw', cwd: '/w', termId: 'pty-cccccccccccc', tmuxPane: null, status: 'starting', statusAt: 1, startedAt: 1, tool: 'codex', server: true, statusSource: 'server' }));
  const now = Date.now();
  let screen = trust;
  const backend = { list: async () => [{ id: 'pty-cccccccccccc', session: 'three', cwd: '/w', pid: 3, activity: now }], capture: async () => screen };
  const deck = new Deck({ backend, config: () => ({}), profiles: () => P.listProfiles(), now: () => now });
  let [card] = await deck.list();
  assert.deepEqual([card.status, card.note], ['attention', 'Codex asks whether to trust this folder. Open the session to answer.']);
  assert.equal(C.busy(card), false, 'nothing waits on it as if it worked');
  screen = '› Ask Codex to do anything';
  [card] = await deck.list();
  assert.equal(card.status, 'starting');
  fs.rmSync(path.join(runs, 'r9.json'));
});
