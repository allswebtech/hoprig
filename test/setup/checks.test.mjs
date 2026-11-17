import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, pathWith, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');

const info = (o) => ({ installed: '2.1.300', path: '/x/claude', latest: '2.1.300', method: 'native', updateAvailable: false, ...o });

test('node version check: 22 is the lowest (src/nodeguard.mjs)', () => {
  assert.equal(K.nodeCheck('22.0.0').status, 'ok');
  assert.equal(K.nodeCheck('26.13.0').status, 'ok');
  for (const v of ['20.20.2', '18.19.1']) {
    const old = K.nodeCheck(v);
    assert.equal(old.status, 'fail', v);
    assert.match(old.detail, /needs 22 or newer/);
    assert.match(old.fix, /^Install Node\.js 22 or newer \(https:\/\/nodejs\.org\)/);
  }
});

test('claude check: missing, broken, off PATH, update available, current, unknown newest', () => {
  assert.equal(K.claudeCheck(info({ installed: null, path: null })).status, 'fail');
  assert.equal(K.claudeCheck(info({ installed: null, path: null })).fix.includes('hoprig setup'), true);
  assert.equal(K.claudeCheck(info({ installed: null })).status, 'fail');
  assert.equal(K.claudeCheck(info(), { onPath: false }).status, 'warn');
  const upd = K.claudeCheck(info({ latest: '2.1.325', updateAvailable: true }));
  assert.equal(upd.status, 'warn');
  assert.equal(upd.fix, 'hoprig claude update');
  assert.equal(K.claudeCheck(info()).status, 'ok');
  assert.match(K.claudeCheck(info({ latest: null })).detail, /unknown/);
});

test('login check: needed only when a profile uses the stored login (or none exists)', () => {
  const login = [{ name: 'sub', kind: 'login' }];
  const api = [{ name: 'api', kind: 'api' }];
  assert.equal(K.loginCheck({ loggedIn: true, method: 'claude.ai' }, login).status, 'ok');
  assert.equal(K.loginCheck({ loggedIn: false }, login).status, 'fail');
  assert.equal(K.loginCheck({ loggedIn: false }, []).status, 'fail');
  assert.equal(K.loginCheck({ loggedIn: false }, api).status, 'warn');
  assert.equal(K.loginCheck({ loggedIn: null, reason: 'old' }, login).status, 'warn');
  assert.match(K.loginCheck({ loggedIn: false }, login).fix, /claude auth login/);
  assert.equal(K.loginCheck({ loggedIn: false }, login).action, 'claude-login', 'the page signs in from the row');
  assert.equal(K.loginCheck({ loggedIn: true }, login).action, undefined);
});

test('profiles check shows names and kinds only', () => {
  assert.equal(K.profilesCheck([]).status, 'warn');
  const r = K.profilesCheck([{ name: 'sub', kind: 'login', env: { X: 'secret' } }, { name: 'api', kind: 'api', env: { ANTHROPIC_API_KEY: 'sk-secret' } }]);
  assert.equal(r.detail, 'sub (login), api (api)');
  assert.doesNotMatch(JSON.stringify(r), /secret/);
});

test('node-pty check: needed without tmux and on Windows, a suggestion otherwise; fix per OS', async () => {
  const bad = async () => ({ ok: false, why: 'it does not load' });
  const good = async () => ({ ok: true });
  const linux = { platform: 'linux', pm: 'apt', root: false };
  assert.equal((await K.ptyCheck(linux, { tmux: true }, good)).status, 'ok');
  assert.equal((await K.ptyCheck(linux, { tmux: true }, bad)).status, 'warn');
  assert.equal((await K.ptyCheck(linux, { tmux: false }, bad)).status, 'fail');
  assert.equal((await K.ptyCheck({ platform: 'win32' }, { tmux: false }, bad)).status, 'fail');
  assert.equal(K.ptyFix(linux, '/app'), 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3 && cd "/app" && npm rebuild node-pty');
  assert.equal(K.ptyFix({ platform: 'linux', pm: 'apk', root: true }, '/app'), 'apk add build-base python3 linux-headers && cd "/app" && npm rebuild node-pty');
  assert.equal(K.ptyFix({ platform: 'darwin', pm: 'brew' }, '/app'), 'xcode-select --install && cd "/app" && npm rebuild node-pty');
  assert.equal(K.ptyFix({ platform: 'win32' }, 'C:\\app'), 'cd "C:\\app" && npm install');
});

test('node-pty: what is on disk names the cause and the one command that builds it', async () => {
  const root = path.join(s.tmp, 'pty-states');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  const pkg = path.join(root, 'node_modules', 'node-pty');
  // npm up to 11 without a compiler: the optional module is left out
  assert.equal(K.ptyState(root, 'linux', 'x64'), 'absent');
  // npm 12: installed, its install script never ran
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"node-pty","version":"1.1.0","main":"index.js"}');
  assert.equal(K.ptyState(root, 'linux', 'x64'), 'unbuilt');
  // a build that was started and did not finish
  fs.mkdirSync(path.join(pkg, 'build'));
  assert.equal(K.ptyState(root, 'linux', 'x64'), 'failed');
  fs.mkdirSync(path.join(pkg, 'build', 'Release'));
  fs.writeFileSync(path.join(pkg, 'build', 'Release', 'pty.node'), '');
  assert.equal(K.ptyState(root, 'linux', 'x64'), 'present');
  // a ready-made build counts only for its own system
  fs.rmSync(path.join(pkg, 'build'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'prebuilds', 'darwin-arm64'), { recursive: true });
  assert.equal(K.ptyState(root, 'darwin', 'arm64'), 'present');
  assert.equal(K.ptyState(root, 'linux', 'x64'), 'unbuilt');

  assert.match(K.ptyCause('unbuilt', 12), /never built: npm 12 does not run the install script of a dependency until it is allowed/);
  assert.match(K.ptyCause('unbuilt', 11), /never built: its install script did not run/);
  assert.match(K.ptyCause('absent'), /not installed: npm leaves it out when it cannot be built/);
  assert.equal(K.ptyCause('present'), '');

  assert.deepEqual(K.ptyRepairArgv('unbuilt', 'linux'), ['npm', 'rebuild', 'node-pty']);
  assert.deepEqual(K.ptyRepairArgv('failed', 'linux'), ['npm', 'rebuild', 'node-pty']);
  assert.deepEqual(K.ptyRepairArgv('absent', 'linux'), ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund']);
  // `npm rebuild` builds only what is there: a module that was left out has to be installed
  const bare = { platform: 'linux', pm: 'apt', root: true, has: () => false };
  assert.equal(K.ptyFix(bare, '/app', 'absent'), 'env DEBIAN_FRONTEND=noninteractive apt-get update && env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3 && cd "/app" && npm install --omit=dev');
  // with the build tools already there the fix is the build alone
  const tools = { platform: 'linux', pm: 'apt', root: false, has: (c) => ['make', 'g++', 'python3'].includes(c) };
  assert.equal(K.ptyFix(tools, '/app', 'unbuilt'), 'cd "/app" && npm rebuild node-pty');

  const bad = async () => ({ ok: false, why: 'it does not load (Failed to load native module: pty.node)' });
  const blocked = await K.ptyCheck(tools, { tmux: false, state: 'unbuilt', npm: 12 }, bad);
  assert.equal(blocked.status, 'fail');
  assert.equal(blocked.detail, 'it was installed but never built: npm 12 does not run the install script of a dependency until it is allowed');
  assert.match(blocked.fix, /^cd ".*" && npm rebuild node-pty$/);
  // with tmux it is a warning, and it says what does not work: tmux keeps sessions, the browser terminal needs the module
  const withTmux = await K.ptyCheck(bare, { tmux: true, state: 'absent' }, bad);
  assert.equal(withTmux.status, 'warn');
  assert.match(withTmux.detail, /^no terminal can open in the browser \(sessions still run in tmux and take messages\): it is not installed/);
  assert.match(withTmux.fix, /apt-get install -y build-essential python3 && cd ".*" && npm install --omit=dev$/);
  // a state that tells nothing keeps the module's own error
  assert.equal((await K.ptyCheck(tools, { tmux: false, state: 'present' }, bad)).detail, 'it does not load (Failed to load native module: pty.node)');
});

test('the only install script npm may run is the one of the node-pty version that is pinned', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(K.appRoot(), 'package.json'), 'utf8'));
  const pinned = pkg.optionalDependencies['node-pty'];
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'an exact version, no range');
  assert.deepEqual(pkg.allowScripts, { [`node-pty@${pinned}`]: true });
});

test('the real terminal module works on this machine', async () => {
  const r = await K.ptyWorks();
  assert.equal(r.ok, true, r.why);
  // and the same asked in a new process, as setup does after it built the module
  assert.deepEqual(await K.ptyWorksNow(), { ok: true });
});

test('terminal: tmux or built-in, information only', async () => {
  const none = await K.terminalCheck({ platform: 'linux', env: { PATH: pathWith(s.tmp) } });
  assert.deepEqual([none.status, none.detail], ['info', 'built-in']);
  const bin = fakeBin(path.join(s.tmp, 'bin-tmux'), { tmux: 'echo "tmux 3.4"' });
  const tm = await K.terminalCheck({ platform: 'linux', env: { PATH: bin } });
  assert.deepEqual([tm.status, tm.detail], ['info', 'tmux 3.4']);
  const oldBin = fakeBin(path.join(s.tmp, 'bin-old-tmux'), { tmux: 'echo "tmux 3.1c"' });
  const old = await K.terminalCheck({ platform: 'linux', env: { PATH: oldBin } });
  assert.deepEqual([old.status, old.detail], ['info', 'built-in (tmux 3.1c is too old: tmux sessions need 3.2 or newer)']);
  assert.equal((await K.terminalCheck({ platform: 'win32', env: { PATH: bin } })).detail, 'built-in');
});

test('service: installed or not, per OS', async () => {
  const sys = { platform: 'darwin', env: {}, home: process.env.HOME, has: () => false };
  assert.equal((await K.serviceCheck(sys)).status, 'warn');
  const plist = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'local.hoprig.dashboard.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, '<plist/>');
  assert.equal(await K.serviceInstalled(sys), true);
  assert.equal((await K.serviceCheck(sys)).status, 'ok');
  fs.rmSync(plist);
  const linux = await K.serviceCheck({ platform: 'linux', env: {}, home: process.env.HOME, has: () => false });
  assert.equal(linux.status, 'info', 'no systemd (a container): information, not a problem');
});

test('port check: 200, refused, something else', async () => {
  assert.equal((await K.portCheck('127.0.0.1', 7433, async () => 200)).status, 'ok');
  const refused = await K.portCheck('127.0.0.1', 7433, async () => 'ECONNREFUSED');
  assert.equal(refused.status, 'warn');
  assert.match(refused.fix, /hoprig serve/);
  assert.match((await K.portCheck('127.0.0.1', 7433, async () => 404)).detail, /another program/);
  // the real probe against a port where nothing listens
  const http = await import('node:http');
  const srv = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  assert.equal(await K.probe('127.0.0.1', port), 'ECONNREFUSED');
});

test('tailscale status parsing and the access line', () => {
  assert.deepEqual(K.parseTailscaleStatus('{"BackendState":"Running","Self":{"DNSName":"pc.tail1.ts.net."}}'), { running: true, dnsName: 'pc.tail1.ts.net' });
  assert.deepEqual(K.parseTailscaleStatus('{"BackendState":"NeedsLogin","Self":{"DNSName":""}}'), { running: false, dnsName: null });
  assert.deepEqual(K.parseTailscaleStatus('not json'), { running: false, dnsName: null });
  const local = K.accessCheck({ server: {} }, { running: false });
  assert.match(local.detail, /this computer only \(127\.0\.0\.1:7433\)/);
  assert.match(K.accessCheck({ server: { host: '0.0.0.0', port: 9000 } }, { running: false }).detail, /local network \(http, port 9000\)/);
  assert.match(K.accessCheck({ server: { allowedOrigins: ['https://pc.tail1.ts.net'] } }, { running: true }).detail, /Tailscale https:\/\/pc\.tail1\.ts\.net\//);
});

test('folder permissions: private is ok, readable by others is a warning with chmod', { skip: process.platform === 'win32' }, () => {
  const before = K.dirsCheck('linux');
  assert.ok(before.every((r) => r.status === 'info'), 'not created yet');
  fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(process.env.HOPRIG_CONFIG_DIR, 0o700);
  fs.mkdirSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'profiles'), { mode: 0o755 });
  fs.chmodSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'profiles'), 0o755);
  const [cfg, prof] = K.dirsCheck('linux');
  assert.equal(cfg.status, 'ok');
  assert.equal(prof.status, 'warn');
  assert.equal(prof.fix, `chmod 700 "${path.join(process.env.HOPRIG_CONFIG_DIR, 'profiles')}"`);
  fs.rmSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
});

test('config check: missing is fine, broken JSON fails', () => {
  assert.equal(K.configCheck().status, 'info');
  fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), '{ broken');
  assert.equal(K.configCheck().status, 'fail');
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), '{"claudeArgs":"not a list"}');
  assert.equal(K.configCheck().status, 'fail');
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), '{}');
  assert.equal(K.configCheck().status, 'ok');
  fs.rmSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
});

test('exit code: 1 only when something needed fails', () => {
  assert.equal(K.exitCodeFor([{ status: 'ok' }, { status: 'warn' }, { status: 'info' }]), 0);
  assert.equal(K.exitCodeFor([{ status: 'ok' }, { status: 'fail' }]), 1);
});

test('shared rules: an @import line is reported when Codex or OpenCode reads the file too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-rules-'));
  try {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Rules\n@~/notes/style.md\nPlain rule. Mail me @ noon.\n  @docs/more.md\n');
    assert.equal(K.sharedRulesCheck({ tools: ['claude'], file }), null, 'Claude Code alone follows them: nothing to say');
    const r = K.sharedRulesCheck({ tools: ['claude', 'codex', 'opencode'], file });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /^2 import lines \(@~\/notes\/style\.md, @docs\/more\.md\)/);
    assert.match(r.detail, /Codex and OpenCode do not/);
    fs.writeFileSync(file, '# Rules\nPlain rule.\n');
    assert.equal(K.sharedRulesCheck({ tools: ['codex'], file }).status, 'ok');
    assert.equal(K.sharedRulesCheck({ tools: ['codex'], file: path.join(dir, 'none.md') }), null, 'no brain: nothing to say');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
