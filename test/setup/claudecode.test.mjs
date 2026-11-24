import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const C = await import('../../src/claudecode.mjs');

const LATEST = 'https://downloads.claude.ai/claude-code-releases/latest';
const STABLE = 'https://downloads.claude.ai/claude-code-releases/stable';
const TAGS = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';

test('install method from the real path of the program', () => {
  assert.equal(C.methodOf('/home/u/.local/share/claude/versions/2.1.325'), 'native');
  assert.equal(C.methodOf('C:\\Users\\u\\.local\\share\\claude\\versions\\2.1.325.exe'), 'native');
  assert.equal(C.methodOf('/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), 'npm');
  assert.equal(C.methodOf('/opt/homebrew/Caskroom/claude-code/2.1.311/claude'), 'unknown');
  assert.equal(C.methodOf('/usr/bin/claude'), 'unknown');
  assert.equal(C.methodOf(null), 'unknown');
});

test('channel: Homebrew casks have their own, else the user setting', () => {
  assert.equal(C.channelFor('/opt/homebrew/Caskroom/claude-code/2.1.311/claude', 'latest'), 'stable');
  assert.equal(C.channelFor('/opt/homebrew/Caskroom/claude-code@latest/2.1.325/claude', 'stable'), 'latest');
  assert.equal(C.channelFor('/home/u/.local/share/claude/versions/2.1.325', 'stable'), 'stable');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  assert.equal(C.readChannel(), 'latest');
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), '{"autoUpdatesChannel":"stable"}');
  assert.equal(C.readChannel(), 'stable');
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'not json');
  assert.equal(C.readChannel(), 'latest');
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
});

test('version output and release answers are parsed strictly', () => {
  assert.equal(C.parseClaudeVersion('2.1.325 (Claude Code)\n'), '2.1.325');
  assert.equal(C.parseClaudeVersion('1.2.3-beta.1 (Claude Code)'), '1.2.3-beta.1');
  assert.equal(C.parseClaudeVersion('command not found'), null);
  assert.equal(C.parseLatestText('2.1.325\n'), '2.1.325');
  assert.equal(C.parseLatestText('<html>error</html>'), null);
  assert.equal(C.parseLatestText(''), null);
  assert.equal(C.parseRegistryTags('{"stable":"2.1.311","latest":"2.1.325","next":"2.1.325"}', 'latest'), '2.1.325');
  assert.equal(C.parseRegistryTags({ stable: '2.1.311', latest: '2.1.325' }, 'stable'), '2.1.311');
  assert.equal(C.parseRegistryTags({ latest: '2.1.325' }, 'stable'), '2.1.325', 'no stable tag: latest');
  assert.equal(C.parseRegistryTags('{"error":"Not found"}', 'latest'), null);
  assert.equal(C.parseRegistryTags('garbage', 'latest'), null);
});

test('where the newest version is asked for', () => {
  assert.deepEqual(C.latestSource('native', 'latest'), { kind: 'text', url: LATEST });
  assert.deepEqual(C.latestSource('unknown', 'stable'), { kind: 'text', url: STABLE });
  assert.deepEqual(C.latestSource('npm', 'stable'), { kind: 'npm', url: TAGS, tag: 'stable' });
});

test('newest-version lookup: cached, null when offline (never guessed)', async () => {
  C.clearLatestCache();
  const calls = [];
  const f = fakeFetch({ [LATEST]: '2.1.325\n', [TAGS]: '{"latest":"2.1.320","stable":"2.1.300"}' }, calls);
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: f, now: 1000 }), '2.1.325');
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: f, now: 2000 }), '2.1.325');
  assert.equal(calls.length, 1, 'the second answer came from the cache');
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: f, now: 1000 + 6 * 60_000 }), '2.1.325');
  assert.equal(calls.length, 2, 'after five minutes it asks again');
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: f, now: 1000 + 6 * 60_000 + 1, fresh: true }), '2.1.325');
  assert.equal(calls.length, 3, 'Check now (fresh) asks at once');
  assert.equal(await C.latestVersion('npm', 'stable', { fetchImpl: f, now: 1000 }), '2.1.300');
  assert.equal(await C.latestVersion('native', 'stable', { fetchImpl: f, now: 1000 }), null, 'offline: null');
  const notOk = async () => ({ ok: false, status: 500, text: async () => '' });
  C.clearLatestCache();
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: notOk, now: 1 }), null);
});

test('the official installer command per OS, and only valid targets', () => {
  assert.deepEqual(C.installerArgv({ platform: 'linux', file: '/tmp/x/install.sh' }), ['bash', '/tmp/x/install.sh']);
  assert.deepEqual(C.installerArgv({ platform: 'darwin', file: '/tmp/x/install.sh', target: 'stable' }), ['bash', '/tmp/x/install.sh', 'stable']);
  assert.deepEqual(C.installerArgv({ platform: 'win32', file: 'C:\\t\\install.ps1', target: '2.1.89' }),
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\t\\install.ps1', '2.1.89']);
  assert.throws(() => C.installerArgv({ platform: 'linux', file: 'f', target: '2.1; rm -rf /' }), /not a version/);
  assert.equal(C.installerUrl('linux'), 'https://claude.ai/install.sh');
  assert.equal(C.installerUrl('darwin'), 'https://claude.ai/install.sh');
  assert.equal(C.installerUrl('win32'), 'https://claude.ai/install.ps1');
});

test('switching versions: claude install for native, npm for npm, refused for package managers', () => {
  assert.deepEqual(C.versionPlan({ method: 'native', bin: '/b/claude', version: '2.1.89' }), { argv: ['/b/claude', 'install', '2.1.89'] });
  assert.deepEqual(C.versionPlan({ method: 'native', bin: '/b/claude', version: 'stable' }), { argv: ['/b/claude', 'install', 'stable'] });
  assert.deepEqual(C.versionPlan({ method: 'npm', bin: '/b/claude', version: '2.1.89', platform: 'linux' }),
    { argv: ['npm', 'install', '-g', '@anthropic-ai/claude-code@2.1.89'] });
  assert.deepEqual(C.versionPlan({ method: 'npm', bin: 'c', version: 'latest', platform: 'win32' }).argv.slice(0, 5), ['cmd.exe', '/d', '/s', '/c', 'npm']);
  assert.match(C.versionPlan({ method: 'unknown', bin: 'c', version: '2.1.89' }).error, /package manager/);
  assert.match(C.versionPlan({ method: 'native', bin: 'c', version: '--force' }).error, /not a version/);
});

test('auth status: exit code and JSON, and nothing personal kept', () => {
  const yes = C.parseAuthStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgName":"X"}' });
  assert.deepEqual(yes, { loggedIn: true, method: 'claude.ai', plan: null });
  // the plan type is kept (it decides whether usage figures exist); e-mail and organisation never are
  const team = C.parseAuthStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"a@b.c","orgName":"X","orgId":"o"}' });
  assert.deepEqual(team, { loggedIn: true, method: 'claude.ai', plan: 'team' });
  assert.equal(C.parseAuthStatus({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none","subscriptionType":"max"}' }).plan, null, 'no plan without a sign-in');
  assert.deepEqual(C.parseAuthStatus({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }), { loggedIn: false, method: 'none', plan: null });
  assert.deepEqual(C.parseAuthStatus({ code: 0, stdout: '{"authMethod":"api_key"}' }), { loggedIn: true, method: 'api_key', plan: null });
  assert.deepEqual(C.parseAuthStatus({ code: 1, stdout: '{"authMethod":"none"}' }), { loggedIn: false, method: 'none', plan: null });
  assert.deepEqual(C.parseAuthStatus({ code: 1, stdout: "error: unknown command 'auth'" }), { loggedIn: null, method: null, plan: null });
  assert.deepEqual(C.parseAuthStatus({ code: null, stdout: '' }), { loggedIn: null, method: null, plan: null });
});

test('resolveClaude: configured name on PATH, else the native location, else null', () => {
  const bin = fakeBin(path.join(s.tmp, 'bin-a'), { claude: fakeClaude() });
  const home = path.join(s.tmp, 'home-native');
  assert.deepEqual(C.resolveClaude({ bin: 'claude', env: { PATH: bin }, platform: 'linux', home }), { path: path.join(bin, 'claude'), onPath: true }); // seal: a value no program is started with
  assert.equal(C.resolveClaude({ bin: 'claude', env: { PATH: '' }, platform: 'linux', home }), null); // seal: a value no program is started with
  fakeBin(path.join(home, '.local', 'bin'), { claude: fakeClaude() });
  assert.deepEqual(C.resolveClaude({ bin: 'claude', env: { PATH: '' }, platform: 'linux', home }), { path: path.join(home, '.local', 'bin', 'claude'), onPath: false }); // seal: a value no program is started with
  assert.equal(C.resolveClaude({ bin: 'my-claude', env: { PATH: '' }, platform: 'linux', home }), null, 'a custom name is not guessed'); // seal: a value no program is started with
  assert.equal(C.nativeBinPath('win32', 'C:\\Users\\u').endsWith('claude.exe'), true);
});

test('claudeInfo with a fake Claude Code: version, method, newest, update available', async () => {
  const bin = fakeBin(path.join(s.tmp, 'bin-info'), { claude: fakeClaude({ version: '2.1.300' }) });
  C.clearLatestCache();
  const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
  const info = await C.claudeInfo({ env, fetchImpl: fakeFetch({ [LATEST]: '2.1.325' }) });
  assert.deepEqual(info, { installed: '2.1.300', path: path.join(bin, 'claude'), latest: '2.1.325', method: 'unknown', updateAvailable: true });
  C.clearLatestCache();
  const offline = await C.claudeInfo({ env, fetchImpl: fakeFetch({}) });
  assert.equal(offline.latest, null);
  assert.equal(offline.updateAvailable, false);
  const none = await C.claudeInfo({ env: { ...process.env, PATH: pathWith(s.tmp) }, fetchImpl: fakeFetch({}) });
  assert.equal(none.installed, null);
  assert.equal(none.path, null);
});

test('login status runs without the profile auth variables', async () => {
  const bin = fakeBin(path.join(s.tmp, 'bin-auth'), {
    // Logged in only when no API key leaks into its environment.
    claude: 'if [ -n "$ANTHROPIC_API_KEY" ]; then echo \'{"loggedIn":true,"authMethod":"api_key"}\'; else echo \'{"loggedIn":false,"authMethod":"none"}\'; exit 1; fi',
  });
  const r = await C.claudeLoginStatus({ env: { ...process.env, PATH: pathWith(s.tmp, bin), ANTHROPIC_API_KEY: 'sk-test' } });
  assert.deepEqual(r, { loggedIn: false, method: 'none', plan: null });
  const missing = await C.claudeLoginStatus({ env: { ...process.env, PATH: pathWith(s.tmp) } });
  assert.equal(missing.loggedIn, null);
});

test('a stand-in "offline" lookup does not leave its answer for the real ones', async () => {
  C.clearLatestCache();
  const offline = async () => ({ ok: false });
  const online = async () => ({ ok: true, text: async () => '2.1.400\n' });
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: offline, now: 1 }), null);
  assert.equal(await C.latestVersion('native', 'latest', { fetchImpl: online, now: 2 }), '2.1.400');
  C.clearLatestCache();
});
