// doctor's exit codes, run as its own process against a scratch home and a PATH of fake programs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fakeClaudeNode as fakeClaude, fakeNodeBin, pathWith, scratch } from './helpers.mjs';
import { sealed } from '../seal.mjs';

if (process.platform === 'win32') process.env.HOPRIG_SEAL_REAL = [process.env.HOPRIG_SEAL_REAL, 'whoami'].filter(Boolean).join(','); // seal: doctor as its own process may ask this account's SID of the system's whoami by its full path when it reads who owns its folders; it only reads

const s = scratch();
test.after(s.cleanup);
const { hashPassword } = await import('../../src/server/auth.mjs');
const CLI = pathToFileURL(path.resolve(import.meta.dirname, '../../src/setup/cli.mjs')).href;

async function freePort() {
  const srv = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** A fresh home for one case: { env } with its own config, state and Claude folders. */
async function home(name, { password = false, programs = {} } = {}) {
  const root = path.join(s.tmp, name);
  const env = sealed({
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    HOPRIG_CONFIG_DIR: path.join(root, 'config'),
    HOPRIG_STATE_DIR: path.join(root, 'state'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    // Only the test's own folders: the seal adds no traps to such a PATH, so a program not given here is not on this
    // computer for doctor, on Windows too. The stand-ins are Node scripts: Windows starts them with this Node, no sh.
    PATH: pathWith(root, fakeNodeBin(path.join(root, 'bin'), programs)),
    NO_COLOR: '1',
    // Windows: the Visual Studio installer's vswhere is looked for here, in the test's own folder where it is not.
    ...(process.platform === 'win32' ? { 'ProgramFiles(x86)': path.join(root, 'no-program-files') } : {}),
  });
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.HOPRIG_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const server = { port: await freePort() };
  if (password) server.passwordHash = await hashPassword('correct horse battery');
  fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ server }));
  return env;
}

function doctor(env, args = ['--offline']) {
  // Ended as bin/hoprig.mjs ends it (exit once the output is written): on Windows a handle of doctor's checks kept the
  // process open after its whole answer was written, until the 60 s limit ended it.
  const code = `const m = await import(${JSON.stringify(CLI)}); const c = await m.main('doctor', ${JSON.stringify(args)}); process.stdout.write('', () => process.stderr.write('', () => process.exit(c)));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('doctor: nothing set up -> exit 1, with a fix for each problem', async () => {
  const r = doctor(await home('bare'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ Claude Code\s+not installed/);
  assert.match(r.out, /fix: hoprig setup/);
  assert.match(r.out, /✗ Dashboard password/);
  assert.match(r.out, /fix: hoprig passwd/);
});

test('doctor: everything needed in place -> exit 0', async () => {
  const env = await home('good', { password: true, programs: { claude: fakeClaude({ loggedIn: true }), tmux: "console.log('tmux 3.4')" } });
  const r = doctor(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ Claude Code\s+2\.1\.300/);
  assert.match(r.out, /✓ Claude login\s+logged in \(claude\.ai\)/);
  assert.match(r.out, /Everything needed works/);
  assert.doesNotMatch(r.out, /someone@example\.com/, 'the account e-mail is never shown');
  assert.doesNotMatch(r.out, /scrypt\$/, 'nor the password hash');
});

test('doctor: not logged in with only a login profile -> exit 1 and the login command', async () => {
  const env = await home('nologin', { password: true, programs: { claude: fakeClaude({ loggedIn: false }), tmux: "console.log('tmux 3.4')" } });
  fs.mkdirSync(path.join(env.HOPRIG_CONFIG_DIR, 'profiles'), { mode: 0o700 });
  fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'profiles', 'sub.env'), 'LABEL=x\n', { mode: 0o600 });
  const r = doctor(env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ Claude login\s+not logged in/);
  assert.match(r.out, /fix: claude   \(then type \/login/);
});

test('doctor: an API profile does not need the login -> exit 0; --json; bad option -> 2', async () => {
  const env = await home('api', { password: true, programs: { claude: fakeClaude({ loggedIn: false }), tmux: "console.log('tmux 3.4')" } });
  fs.mkdirSync(path.join(env.HOPRIG_CONFIG_DIR, 'profiles'), { mode: 0o700 });
  fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'profiles', 'api.env'), 'ANTHROPIC_API_KEY=sk-ant-secret-value\n', { mode: 0o600 });
  const r = doctor(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ Profiles\s+api \(api\)/);
  assert.doesNotMatch(r.out, /sk-ant-secret-value/);
  const j = doctor(env, ['--offline', '--json']);
  assert.equal(j.code, 0);
  assert.equal(JSON.parse(j.out).ok, true);
  assert.equal(doctor(env, ['--what']).code, 2);
});

test('doctor: a broken settings file -> exit 1', async () => {
  const env = await home('broken', { password: true, programs: { claude: fakeClaude(), tmux: "console.log('tmux 3.4')" } });
  fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'config.json'), '{ not json');
  // Unreadable settings name no port: doctor would ask the default, where this computer's own dashboard may listen.
  env.PORT = String(await freePort());
  const r = doctor(env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ Settings file/);
});

test('doctor: a fix that needs administrator rights is phrased for this user (sudo, root, or "as root:" without sudo)', async () => {
  const { overview } = await import('../../src/setup/overview.mjs');
  const { sysInfo } = await import('../../src/setup/checks.mjs');
  const env = await home('phrasing', { password: true, programs: { claude: fakeClaude({ loggedIn: true }) } });
  const fix = 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux';
  const parts = {
    pc: async () => [{ group: 'kit:extras', id: 'extras.tmux', label: 'tmux', status: 'fail', detail: 'missing', fix }],
    skills: async () => ({ user: { installed: [], suggested: [] }, updates: [], checked: true }),
    workspace: async () => ({ id: 'workspace', label: 'Workspace', status: 'ok', detail: 'here', fix: '' }),
  };
  const fixFor = async (over) => {
    // The checks run in this process, on its settings (no port in them): the port is answered here, not asked.
    const list = await overview({ sys: sysInfo({ env: { ...process.env, ...env }, platform: 'linux', pm: 'apt', probe: async () => 0, running: async () => null, ...over }), offline: true, parts });
    return list.find((c) => c.id === 'extras.tmux').fix;
  };
  // No systemd here: what this test reads is the phrasing, and the look at systemd would start the computer's own.
  assert.equal(await fixFor({ root: false, has: (c) => c !== 'systemctl' }), fix);
  assert.equal(await fixFor({ root: true, has: () => false }), 'env DEBIAN_FRONTEND=noninteractive apt-get update && env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux');
  assert.equal(await fixFor({ root: false, has: (c) => c !== 'sudo' && c !== 'systemctl' }), 'as root: env DEBIAN_FRONTEND=noninteractive apt-get update && env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux');
});
