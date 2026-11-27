// How Claude Code was installed, as doctor and Updates say it: on Windows npm's claude.cmd shim is npm, and a path
// in other letter case is still the official installer's. What is neither is "installed some other way" on every
// system, never "a package manager" (a copy put there by hand is not one). And the Windows lines of doctor (long
// paths, the owner of the folders) reach Health too. Made-up answers: nothing real runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, scratch } from './helpers.mjs';
import { closedGateways } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({});
(await import('../../src/config.mjs')).saveConfig({ server: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() }, addons: closedGateways() });
const { methodOf } = await import('../../src/claudecode.mjs');
const K = await import('../../src/setup/checks.mjs');
const O = await import('../../src/setup/overview.mjs');
const H = await import('../../src/machines/health.mjs');
const { toolItem } = await import('../../src/automation/updateitems.mjs');
const { which } = await import('../../src/setup/system.mjs');

test('Windows: npm\'s claude.cmd shim is npm; the official installer\'s paths in any letter case are native', () => {
  const npmDir = 'C:\\Users\\alex\\AppData\\Roaming\\npm';
  const there = (want) => (p) => p === want;
  const pkg = path.win32.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code');
  assert.equal(methodOf(`${npmDir}\\claude.cmd`, 'win32', there(pkg)), 'npm');
  assert.equal(methodOf(`${npmDir}\\claude.ps1`, 'win32', there(pkg)), 'npm');
  assert.equal(methodOf(`${npmDir}\\claude.cmd`, 'win32', () => false), 'unknown', 'a .cmd with no npm package beside it');
  assert.equal(methodOf('C:\\USERS\\ALEX\\.LOCAL\\SHARE\\CLAUDE\\VERSIONS\\2.1.325.exe', 'win32'), 'native');
  assert.equal(methodOf('c:/users/alex/.local/share/claude/versions/2.1.325.exe', 'win32'), 'native');
  assert.equal(methodOf('C:\\Users\\alex\\.local\\bin\\claude.exe', 'win32'), 'native');
  assert.equal(methodOf('C:\\Users\\alex\\AppData\\Roaming\\npm\\NODE_MODULES\\@anthropic-ai\\claude-code\\bin\\claude.exe', 'win32'), 'npm');
  assert.equal(methodOf('C:\\Users\\alex\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe', 'win32'), 'unknown');
  // Elsewhere letter case is a different folder, and no .cmd is looked at.
  assert.equal(methodOf('/home/alex/.LOCAL/share/claude/versions/2.1.325', 'linux'), 'unknown');
  assert.equal(methodOf('/home/alex/npm/claude.cmd', 'linux', () => true), 'unknown');
  assert.equal(methodOf('/home/alex/.local/share/claude/versions/2.1.325', 'linux'), 'native');
});

test('neither the official installer nor npm: "installed some other way", never "a package manager" (every system)', async () => {
  const c = K.claudeCheck({ installed: '2.1.300', path: '/usr/bin/claude', latest: '2.1.300', method: 'unknown', updateAvailable: false });
  assert.equal(c.detail, '2.1.300 (installed some other way), the newest');
  assert.doesNotMatch(c.detail, /package manager/);
  const tool = { id: 'claude', name: 'Claude Code', managed: false, updateItem: { whenRunning: 'keeps-copy' }, info: async () => ({ installed: '2.1.300', latest: '2.1.300', method: 'unknown' }) };
  const shown = (await toolItem('claude', { tool }).info()).method;
  assert.equal(shown, 'something other than the official installer or npm');
});

test('Health shows the Windows lines of doctor: long paths in Windows and git, and the owner of the folders', async () => {
  const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: true }) });
  const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
  delete env.container;
  fs.mkdirSync(process.env.HOPRIG_WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const asked = [];
  const run = async (argv) => {
    asked.push(argv.join(' '));
    if (argv[0] === 'reg') return { ok: true, stdout: `\r\n${K.LONGPATHS_KEY}\r\n    LongPathsEnabled    REG_DWORD    0x0\r\n`, stderr: '' };
    if (argv[0] === 'git' && argv[1] === 'config') return { ok: false, stdout: '', stderr: '' };
    if (argv[0] === 'powershell.exe') return { ok: true, stdout: 'S-1-5-32-544\r\n', stderr: '' };
    // Windows' own whoami comes by its full path there (winowner.mjs whoamiBin).
    if (/(^|[\\/])whoami(\.exe)?$/i.test(argv[0])) return { ok: true, stdout: '"pc-example\\alex","S-1-5-21-1-2-3-1001"\r\n', stderr: '' };
    return { ok: false, stdout: '', stderr: 'not here' };
  };
  const sys = K.sysInfo({ env, has: (c) => c === 'git' || !!which(c, env, process.platform), pm: null, platform: 'win32', exists: () => false, probe: async () => 0, running: async () => null, run });
  const parts = { pc: async () => [], skills: async () => ({ user: { installed: [], suggested: [] }, updates: [], checked: true }), workspace: async () => [] };
  // Health reads doctor's checks offline (machines/health.mjs): the HTTPS read of git is doctor's alone.
  const list = H.healthChecks(await O.overview({ sys, offline: true, parts }));
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(byId.longpaths?.status, 'info');
  assert.match(byId.longpaths.fix, /LongPathsEnabled -Value 1/);
  assert.equal(byId.gitlongpaths?.fix, 'git config --global core.longpaths true');
  assert.equal(byId.winowner?.status, 'warn');
  assert.match(byId.winowner.fix, /^& \{ .+ \} '\*S-1-5-21-1-2-3-1001' '.+', '.+'$/);
  // The script itself, without the folders it is given: a temporary folder of macOS has /T/ in its own path.
  assert.doesNotMatch(byId.winowner.fix.slice(0, byId.winowner.fix.indexOf(" } '")), /\/T\b/);
  assert.equal(byId.githttps, undefined);
  assert.ok(asked.every((a) => !/^icacls|ls-remote/.test(a)), asked.join('\n'));
});
