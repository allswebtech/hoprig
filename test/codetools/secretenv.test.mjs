// One environment full of made-up secrets (a provider's key and address, a coding tool's sign-in and server
// password, Hoprig's own token) goes through every place that starts npm, an install script, a download, a coding
// tool's server or sign-in: none of the secrets comes out at the other end. The places that start a program
// directly are run with stand-in programs on PATH that write down the environment they got; nothing is installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secretenv-'));
Object.assign(process.env, {
  HOPRIG_STATE_DIR: path.join(tmp, 'state'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_PROFILES_DIR: path.join(tmp, 'profiles'),
  HOPRIG_WORKSPACE_DIR: path.join(tmp, 'ws'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), HOPRIG_TOOLS_DIR: path.join(tmp, 'tools'),
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MARK = 'made-up-secret';
const SECRETS = {
  ANTHROPIC_API_KEY: `${MARK}-1`, ANTHROPIC_AUTH_TOKEN: `${MARK}-2`, ANTHROPIC_BASE_URL: `https://${MARK}-3.example`,
  ANTHROPIC_CUSTOM_HEADERS: `x-key: ${MARK}-4`, CLAUDE_CODE_OAUTH_TOKEN: `${MARK}-5`,
  OPENAI_API_KEY: `${MARK}-6`, OPENAI_BASE_URL: `https://${MARK}-7.example`, CODEX_API_KEY: `${MARK}-8`,
  OPENCODE_PASSWORD: `${MARK}-9`, HOPRIG_OPENCODE_KEY_WORK: `${MARK}-10`, HOPRIG_CODEX_KEY_WORK: `${MARK}-11`,
  HOPRIG_CODEX_WS: `${MARK}-12`, HOPRIG_ASSISTANT_TOKEN: `${MARK}-13`, HOPRIG_ASSISTANT_TOKEN_FILE: `/${MARK}-14`,
  HOPRIG_PASSWORD_FILE: `/${MARK}-15`,
};
const FAKE = { ...process.env, ...SECRETS, KEEP_ME: 'plain' };
const leaks = (env, own = []) => Object.entries(env || {}).filter(([k, v]) => !own.includes(k) && String(v).includes(MARK)).map(([k]) => k);

test('the one list: every kind of secret, and nothing else', async () => {
  const { isSecretVar, withoutSecrets } = await import('../../src/secretenv.mjs');
  for (const k of Object.keys(SECRETS)) assert.ok(isSecretVar(k), k);
  for (const k of ['PATH', 'HOME', 'LANG', 'KEEP_ME', 'HOPRIG_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'OPENAI_URL']) assert.ok(!isSecretVar(k), k);
  const out = withoutSecrets(FAKE);
  assert.deepEqual(leaks(out), []);
  assert.equal(out.KEEP_ME, 'plain');
});

test('an install also loses GitHub\'s tokens and the credential names a stored provider exports', async () => {
  const { forInstalls, withoutSecrets } = await import('../../src/secretenv.mjs');
  const { writeProfile, deleteProfile } = await import('../../src/profiles.mjs');
  writeProfile('bedrock', { label: 'Bedrock', env: { AWS_BEARER_TOKEN_BEDROCK: 'x', GATEWAY_KEY: 'x', AWS_REGION: 'x', CLAUDE_CODE_USE_BEDROCK: '1' } });
  try {
    const env = { ...FAKE, GH_TOKEN: `${MARK}-gh`, GITHUB_TOKEN: `${MARK}-gh2`, GH_ENTERPRISE_TOKEN: `${MARK}-gh3`, AWS_BEARER_TOKEN_BEDROCK: `${MARK}-aws`, GATEWAY_KEY: `${MARK}-gw`, AWS_REGION: 'eu-west-1', NPM_TOKEN: 'owner-own' };
    const out = forInstalls(env);
    assert.deepEqual(leaks(out), []);
    // A provider's region is no secret, and the owner's own npm token is not a provider's.
    assert.deepEqual([out.AWS_REGION, out.NPM_TOKEN, out.KEEP_ME], ['eu-west-1', 'owner-own', 'plain']);
    // A coding tool keeps the owner's GitHub token (its gh, its git push): only installs lose it.
    assert.equal(withoutSecrets(env).GH_TOKEN, `${MARK}-gh`);
  } finally {
    deleteProfile('bedrock');
  }
});

test('the environments built for npm, a coding tool, its server and its sign-in carry none of them', async () => {
  const { installEnv } = await import('../../src/codetools/npmtool.mjs');
  const claudecode = await import('../../src/claudecode.mjs');
  const servers = await import('../../src/codetools/servers.mjs');
  const { toolEnv } = await import('../../src/codetools/providers.mjs');
  const { signinEnv } = await import('../../src/server/accounts.mjs');
  const { loginEnv } = await import('../../src/server/claudelogin.mjs');
  assert.deepEqual(leaks(installEnv(FAKE, { XDG_DATA_HOME: '/x' })), [], 'npm and its install script');
  assert.deepEqual(leaks(claudecode.cleanEnv(FAKE)), [], "Claude Code's installer, update and version check");
  assert.deepEqual(leaks(servers.cleanEnv(FAKE)), [], "a coding tool's process");
  assert.deepEqual(leaks(servers.serverEnv('opencode', [], FAKE)), [], "a coding tool's server");
  assert.deepEqual(leaks(signinEnv(FAKE)), [], 'claude setup-token');
  assert.deepEqual(leaks(loginEnv(FAKE)), [], 'claude auth login');
  // A tool started for a provider gets that provider's key in its one variable, and nothing of the others.
  const profile = { name: 'work', kind: 'openai', tools: ['opencode'], env: { OPENAI_API_KEY: 'its-own-key' } };
  const env = toolEnv('opencode', profile, FAKE);
  assert.deepEqual(leaks(env), []);
  assert.ok(Object.values(env).includes('its-own-key'), 'its own key is there');
});

// Stand-in programs: each writes the environment it got into the dump folder and ends with success.
const bin = path.join(tmp, 'bin');
const dumps = path.join(tmp, 'dumps');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(dumps, { recursive: true });
const STUB = `#!/bin/sh\nenv > "${dumps}/$(basename "$0").$$"\ncase "$1" in --version|-v) echo 2.1.0 ;; esac\nexit 0\n`;
for (const name of ['npm', 'git', 'tar', 'claude', 'pnpm']) fs.writeFileSync(path.join(bin, name), STUB, { mode: 0o755 });
const seen = () => fs.readdirSync(dumps).map((f) => ({ prog: f.split('.')[0], text: fs.readFileSync(path.join(dumps, f), 'utf8') }));

// A runner that records the environment each command was given (the places that take a runner).
function recorder() {
  const calls = [];
  const run = async (argv, opts = {}) => {
    calls.push({ argv, env: opts.env });
    return { ok: true, code: 0, stdout: '2.3.0\n', stderr: '', output: '' };
  };
  return { calls, run };
}

test('every place that starts npm, an install script or a download hands on none of them', { skip: process.platform === 'win32' && 'the stand-in programs are shell scripts' }, async () => {
  const saved = { ...process.env };
  Object.assign(process.env, SECRETS, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  try {
    // OpenCode's npm install into Hoprig's tools folder (the runner and the version check are recorded).
    const { opencode } = await import('../../src/codetools/opencode.mjs');
    const r1 = recorder();
    await opencode.install({ run: r1.run, check: r1.run });
    assert.ok(r1.calls.length >= 1, 'npm ran');
    for (const c of r1.calls) assert.deepEqual(leaks(c.env), [], c.argv.join(' '));

    // Hoprig's own update, from a checkout (git pull, npm install) and from an npm install (npm install -g), in the
    // command and on the Updates page. Both kinds are made here: where the suite itself runs (a checkout or an
    // unpacked copy) decides nothing.
    const { selfUpdate } = await import('../../src/setup/selfupdate.mjs');
    const checkout = path.join(tmp, 'checkout');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    const installed = path.join(tmp, 'prefix', 'lib', 'node_modules', 'hoprig');
    fs.mkdirSync(installed, { recursive: true });
    const r2 = recorder();
    const newer = async () => ({ version: '999.0.0', note: null });
    assert.equal(await selfUpdate([], { write: () => {}, run: r2.run, root: checkout, lookup: newer }), 0);
    const fromGit = r2.calls.length;
    assert.equal(await selfUpdate([], { write: () => {}, run: r2.run, root: installed, lookup: newer }), 0);
    assert.ok(fromGit >= 1 && r2.calls.length > fromGit, `${fromGit} ${r2.calls.length}`);
    const { hoprigItem } = await import('../../src/automation/updateitems.mjs');
    const r3 = recorder();
    const item = hoprigItem({
      stream: r3.run, run: async (argv) => ({ ok: true, code: 0, stdout: argv.includes('status') ? '' : 'x\n', stderr: '' }),
      selfupdate: { installKind: () => 'git', updatePlan: () => [{ argv: ['git', 'pull'], cwd: tmp }, { argv: ['npm', 'install'], cwd: tmp }] },
    });
    await item.update({ onLine: () => {} });
    for (const c of [...r2.calls, ...r3.calls]) assert.deepEqual(leaks(c.env), [], c.argv.join(' '));
    assert.ok(r2.calls.length >= 1 && r3.calls.length >= 1, `${r2.calls.length} ${r3.calls.length}`);

    // A project's dependency install (Set up a project).
    const { offerInstall } = await import('../../src/pcsetup/setup.mjs');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), '{}');
    const r4 = recorder();
    await offerInstall({ line: () => {}, out: () => {}, confirm: async () => true }, proj, r4.run, { has: () => true });
    assert.equal(r4.calls.length, 1);
    assert.deepEqual(leaks(r4.calls[0].env), []);

    // A PC-setup kit's steps (nvm's install script, Docker's, Homebrew's, package managers), from the command and
    // from the dashboard's job (its runner, also when a caller hands it the whole environment).
    const { runSteps } = await import('../../src/pcsetup/setup.mjs');
    const { adminRunner } = await import('../../src/pcsetup/admin.mjs');
    const steps = [{ kit: 'node', argv: ['bash', '-c', 'curl -o- https://example.invalid/install.sh | bash'] }];
    const quiet = { out: () => {}, line: () => {} };
    const r5 = recorder();
    await runSteps(steps, { ui: quiet, interactive: false, runner: r5.run });
    const r6 = recorder();
    await runSteps(steps, { ui: quiet, interactive: false, runner: adminRunner(null, r6.run) });
    const r7 = recorder();
    await adminRunner(null, r7.run)(['npm', 'install', '-g', 'x'], { env: process.env });
    for (const c of [...r5.calls, ...r6.calls, ...r7.calls]) assert.deepEqual(leaks(c.env), [], c.argv.join(' '));
    assert.deepEqual([r5.calls.length, r6.calls.length, r7.calls.length], [1, 1, 1]);

    // GitHub's token: a kit's step loses it in the dashboard's job too, while a clone of a project (a private
    // repository may need it) keeps it there as it does in the command. The secrets go either way.
    process.env.GH_TOKEN = `${MARK}-gh`;
    try {
      const { cloneRepo } = await import('../../src/pcsetup/projects.mjs');
      const r8 = recorder();
      await runSteps(steps, { ui: quiet, interactive: false, runner: adminRunner(null, r8.run) });
      await adminRunner(null, r8.run)(['brew', 'install', 'x']); // no env given: as an install
      await cloneRepo({ url: 'https://example.invalid/o/private.git', name: 'private' }, path.join(tmp, 'clones'), { run: adminRunner(null, r8.run) });
      await cloneRepo({ url: 'https://example.invalid/o/private.git', name: 'private2' }, path.join(tmp, 'clones'), { run: r8.run });
      const [kit, bare, viaJob, viaCommand] = r8.calls;
      assert.deepEqual([leaks(kit.env), leaks(bare.env)], [[], []], 'a kit or an install loses the token too');
      for (const c of [viaJob, viaCommand]) assert.deepEqual(leaks(c.env), ['GH_TOKEN'], 'a clone keeps GitHub\'s token and nothing else');
    } finally {
      delete process.env.GH_TOKEN;
    }

    // These start the program themselves: the stand-ins on PATH write down what they got.
    const { updateTool } = await import('../../src/skillhub/tools.mjs');
    await updateTool({ command: ['npm', 'install', '--global', 'some-tool@1.0.0'] });
    const { trouteai } = await import('../../src/addons/trouteai.mjs');
    await trouteai.install({});
    const { buildTerminal } = await import('../../src/setup/setup.mjs');
    await buildTerminal({ note: () => {}, out: () => {} }, { env: process.env, platform: process.platform }, () => true);
    const claudecode = await import('../../src/claudecode.mjs');
    await claudecode.claudeUpdate({});
    const got = seen();
    for (const prog of ['npm', 'claude']) assert.ok(got.some((g) => g.prog === prog), `${prog} ran`);
    for (const g of got) assert.ok(!g.text.includes(MARK), `${g.prog} got a secret: ${g.text.split('\n').filter((l) => l.includes(MARK)).map((l) => l.split('=')[0]).join(', ')}`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
