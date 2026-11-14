import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder, scratch, snapshot } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
// No test may reach the network: the newest-version lookup gets a fixed answer.
globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });

const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { loadConfig } = await import('../../src/config.mjs');
const { listProfiles } = await import('../../src/profiles.mjs');
const { which } = await import('../../src/setup/system.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: true }) });
const PATH = pathWith(s.tmp, bin);

/** A system with only the fake programs: no package manager, no service manager, so nothing real is touched. */
function sys(over = {}) {
  const env = { ...process.env, PATH: over.PATH || PATH };
  const has = (c) => c !== 'systemctl' && !!which(c, env, process.platform);
  const { PATH: _p, ...rest } = over;
  const made = K.sysInfo({ env, has, pm: null, root: false, serviceSupported: false, publicIps: [], ...rest });
  // Nothing listens for these tests, whatever really runs on this machine's dashboard port.
  made.probe = over.probe || (async () => 0);
  return made;
}

const noQuestions = async (q) => {
  throw new Error(`unexpected question: ${q}`);
};
// The parts after the dashboard's steps (computer, project, skills) are tested in firstrun.test.mjs: here they do nothing.
const NOPARTS = {
  workspace: async () => ({ ok: true, changed: false }),
  pc: async () => ({ ok: true, changed: false, missing: [], code: 0 }),
  projects: async () => ({ dir: '/nowhere', names: ['demo'] }),
  projectSkills: async () => ({ ok: true, added: [], skipped: [] }),
  userSkills: async () => ({ ok: true, added: [], skipped: [] }),
};
const ui = (o = {}) => {
  const rec = recorder();
  return { rec, ui: makeUi({ interactive: false, write: rec.write, askLine: noQuestions, ...o }) };
};
const stateDirs = () => ({ ...snapshot(process.env.HOPRIG_CONFIG_DIR), ...snapshot(process.env.HOPRIG_STATE_DIR) });

test('setup arguments', () => {
  assert.deepEqual(SU.parseSetupArgs([]), { yes: false, dryRun: false, passwordFile: null, access: null, service: true, hub: false, domain: null, ip: null, tlsInternal: false, only: null });
  assert.deepEqual(SU.parseSetupArgs(['--yes', '--dry-run', '--password-file', 'p.txt', '--access', 'local', '--no-service']),
    { yes: true, dryRun: true, passwordFile: 'p.txt', access: 'local', service: false, hub: false, domain: null, ip: null, tlsInternal: false, only: null });
  assert.deepEqual(SU.parseSetupArgs(['--hub', '--domain', 'hub.example.com', '--tls-internal']).domain, 'hub.example.com');
  assert.equal(SU.parseSetupArgs(['--hub', '--ip=95.216.1.2']).ip, '95.216.1.2');
  assert.deepEqual(SU.parseSetupArgs(['-y', '--access=tailscale']).access, 'tailscale');
  assert.throws(() => SU.parseSetupArgs(['--access', 'world']), /must be one of/);
  assert.throws(() => SU.parseSetupArgs(['--bogus']), /unknown option/);
  assert.throws(() => SU.parseSetupArgs(['--password-file']), /needs a value/);
});

test('what the official installer needs first (docs: Alpine needs bash and curl)', () => {
  const has = (...names) => ({ platform: 'linux', has: (c) => names.includes(c) });
  assert.deepEqual(SU.installerNeeds(has('bash', 'curl')), []);
  assert.deepEqual(SU.installerNeeds(has('bash', 'wget')), []);
  assert.deepEqual(SU.installerNeeds(has('wget')), ['bash']);
  assert.deepEqual(SU.installerNeeds(has()), ['bash', 'curl']);
  assert.deepEqual(SU.installerNeeds({ platform: 'win32', has: () => false }), []);
});

test('access: tailscale command, URLs, and what counts as already decided', () => {
  assert.deepEqual(SU.tailscaleServeArgv('/usr/bin/tailscale', 7433), ['/usr/bin/tailscale', 'serve', '--bg', '7433']);
  assert.equal(SU.tailscaleUrl('pc.tail1.ts.net'), 'https://pc.tail1.ts.net/');
  const nets = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }] };
  assert.deepEqual(SU.lanUrls(7433, nets), ['http://192.168.1.5:7433/']);
  assert.equal(SU.currentAccess({}, null), null, 'never chosen');
  assert.equal(SU.currentAccess({ server: { host: '127.0.0.1' } }, null), 'local');
  assert.equal(SU.currentAccess({ server: { host: '0.0.0.0' } }, null), 'network');
  assert.equal(SU.currentAccess({ server: { host: '127.0.0.1', allowedOrigins: ['https://pc.ts.net'] } }, 'https://pc.ts.net'), 'tailscale');
});

test('the --yes and --dry-run question rules', async () => {
  const dry = ui({ dryRun: true, yes: true });
  assert.equal(await dry.ui.confirm('Do it?', true), false, 'dry run never says yes');
  assert.match(dry.rec.text, /\(dry run\) would ask: Do it\?/);
  const yes = ui({ yes: true });
  assert.equal(await yes.ui.confirm('Do it?', true), true);
  assert.equal(await yes.ui.choose('Which?', [{ key: '1', label: 'a' }, { key: '2', label: 'b' }], '2'), '2');
  assert.equal(await ui().ui.confirm('Do it?', true), false, 'no terminal: nothing changes');
  const answers = ['maybe', 'y'];
  const asked = makeUi({ interactive: true, write: () => {}, askLine: async () => answers.shift() });
  assert.equal(await asked.confirm('Do it?', false), true);
});

test('setup --dry-run changes nothing and says what it would do', async () => {
  const before = stateDirs();
  const { ui: u, rec } = ui({ dryRun: true });
  assert.equal(await SU.setup(['--dry-run'], { ui: u, sys: sys({ serviceSupported: true }), parts: NOPARTS }), 0);
  assert.deepEqual(stateDirs(), before);
  assert.equal(fs.existsSync(process.env.HOPRIG_CONFIG_DIR), false, 'not even the settings folder was created');
  assert.match(rec.text, /Would create the profile "sub"/);
  assert.match(rec.text, /Would generate a dashboard password into/);
  assert.match(rec.text, /Who should be able to open the dashboard\?/);
  assert.match(rec.text, /Would install and start the background service/);
  assert.match(rec.text, /Dry run: nothing was changed/);
});

test('setup --dry-run with Claude Code missing: one install question, nothing installed', async () => {
  const empty = fakeBin(path.join(s.tmp, 'bin-empty'), {});
  const { ui: u, rec } = ui({ dryRun: true });
  await SU.setup(['--dry-run'], { ui: u, sys: sys({ PATH: pathWith(s.tmp, empty), platform: 'linux' }), parts: NOPARTS });
  assert.match(rec.text, /Claude Code is not installed\./);
  assert.match(rec.text, /would ask: Install it now\?/);
  assert.equal(fs.existsSync(path.join(process.env.HOME, '.local')), false);
});

test('setup --yes: profile, password file, network access, no questions; a second run changes nothing', async () => {
  const first = ui({ yes: true });
  const code = await SU.setup(['--yes'], { ui: first.ui, sys: sys(), parts: NOPARTS });
  assert.equal(code, 0, first.rec.text);
  assert.deepEqual(listProfiles().map((p) => [p.name, p.kind]), [['sub', 'login']]);
  const pwFile = SU.defaultPasswordFile();
  assert.ok(fs.existsSync(pwFile));
  if (process.platform !== 'win32') assert.equal(fs.statSync(pwFile).mode & 0o777, 0o600);
  assert.match(loadConfig().server.passwordHash, /^scrypt\$/);
  assert.equal(loadConfig().server.host, '0.0.0.0', 'the default answer: devices on my network');
  assert.doesNotMatch(first.rec.text, new RegExp(fs.readFileSync(pwFile, 'utf8').trim()), 'the password itself is never printed');
  assert.match(first.rec.text, /Password, if asked: in .*dashboard-password\.txt/);
  assert.match(first.rec.text, /Add another provider: hoprig add/);
  assert.ok(first.rec.text.split('\n').length < 60, 'fits on one screen');

  // Plain setup, interactive, everything decided: not one question.
  // Every run ends with a fresh one-time sign-in link, so that one file is expected to differ.
  const settled = () => JSON.parse(JSON.stringify(stateDirs(), (k, v) => (k === 'login-links.json' ? undefined : v)));
  const after = settled();
  const again = ui({ interactive: true });
  assert.equal(await SU.setup([], { ui: again.ui, sys: sys(), parts: NOPARTS }), 0, again.rec.text);
  assert.deepEqual(settled(), after, 'running setup again changed nothing');
});

test('--access changes the choice without a question; Tailscale uses tailscale serve', async () => {
  const tsBin = fakeBin(path.join(s.tmp, 'bin-ts'), {
    tailscale: 'case "$1" in status) echo \'{"BackendState":"Running","Self":{"DNSName":"pc.tail1.ts.net."}}\' ;; serve) echo "serving $3" ;; esac',
  });
  const S2 = sys({ PATH: pathWith(s.tmp, bin, tsBin) });
  const run = async (access) => {
    const state = { changed: false };
    const { ui: u, rec } = ui();
    await SU.stepAccess(u, S2, { access }, state);
    return { state, text: rec.text };
  };
  await run('local');
  assert.equal(loadConfig().server.host, '127.0.0.1');
  const ts = await run('tailscale');
  assert.equal(ts.state.phoneUrl, 'https://pc.tail1.ts.net/');
  assert.deepEqual(loadConfig().server.allowedOrigins, ['https://pc.tail1.ts.net']);
  const same = await run(null);
  assert.equal(same.state.changed, false, 'already Tailscale: nothing to do');
  assert.equal(same.state.phoneUrl, 'https://pc.tail1.ts.net/');
  const noTs = ui();
  assert.equal(await SU.stepAccess(noTs.ui, sys(), { access: 'tailscale' }, {}), false);
  assert.match(noTs.rec.text, /Tailscale is not installed: get it at https:\/\/tailscale\.com\/download/);
  await run('network');
});

test('the question offers Tailscale only when it is logged in; the default is the network', async () => {
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ server: { passwordHash: loadConfig().server.passwordHash } }));
  const asked = [];
  const u = makeUi({ interactive: true, write: (t) => asked.push(t), askLine: async () => '' });
  await SU.stepAccess(u, sys(), {}, {});
  const text = asked.join('');
  assert.match(text, /1 {2}only this computer/);
  assert.match(text, /2 {2}devices on my network.*\(default\)/);
  assert.doesNotMatch(text, /Tailscale/);
  assert.equal(loadConfig().server.host, '0.0.0.0');
});

test('not logged in: one line, and setup goes on', async () => {
  const nl = fakeBin(path.join(s.tmp, 'bin-nologin'), { claude: fakeClaude({ loggedIn: false }) });
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await SU.setup(['--yes'], { ui: u, sys: sys({ PATH: pathWith(s.tmp, nl) }), parts: NOPARTS }), 0);
  assert.match(rec.text, /No Claude account logged in: run "claude" once, type \/login, then run setup again\./);
});

test('summary: a QR code that signs the phone in (a one-time link), the address, and where the password is', async () => {
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepSummary(u, { phoneUrl: 'https://pc.tail1.ts.net/', passwordFile: '/x/pw.txt' });
  assert.match(rec.text, /Scan with your phone's camera to sign in \(the link works once, for 15 minutes\):/);
  assert.match(rec.text, /https:\/\/pc\.tail1\.ts\.net\/login#link=[\w-]{20,}/);
  assert.match(rec.text, /[▀▄█]/);
  assert.match(rec.text, /https:\/\/pc\.tail1\.ts\.net\//);
  assert.match(rec.text, /Password, if asked: in \/x\/pw\.txt/);
  assert.equal(await SU.loginLink('https://pc.tail1.ts.net/').then((l) => l === null || typeof l.url === 'string'), true);
});

test('--no-service and machines without a service manager never install one', async () => {
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepService(u, sys({ serviceSupported: true }), { service: false }, { changed: true });
  assert.match(rec.text, /start it with "hoprig serve"/);
  const other = ui({ yes: true });
  await SU.stepService(other.ui, sys(), { service: true }, { changed: true });
  assert.match(other.rec.text, /no background service here/);
});

test('--hub: a computer that only shows the others needs no Claude Code, account or terminal', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const empty = fakeBin(path.join(s.tmp, 'bin-hub'), {});
  const S3 = sys({ PATH: empty });
  const { ui: u, rec } = ui({ yes: true });
  const code = await SU.setup(['--hub', '--yes', '--no-service', '--access', 'local'], { ui: u, sys: S3 });
  assert.equal(code, 0, rec.text);
  assert.match(rec.text, /Hub only: this computer shows your other computers/);
  assert.doesNotMatch(rec.text, /Claude Code is not installed|Install it now/);
  assert.equal(loadConfig().hubOnly, true);
  // The line to type on the other computers comes from machines/hubcert.mjs (it carries --fingerprint when the
  // hub's certificate is its own). A hub on this computer's own plain address needs neither that nor --insecure.
  assert.match(rec.text, /Connect each PC to it \(the code works once, for 10 minutes\): hoprig join http:\/\/127\.0\.0\.1:\d+ [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\n/);
  // The doctor agrees: nothing about Claude Code counts as a problem here.
  const results = await K.allChecks({ sys: S3, offline: true });
  const claude = results.find((r) => r.id === 'claude');
  assert.deepEqual([claude.status, /not needed on a hub/.test(claude.detail)], ['info', true]);
  saveConfig({ hubOnly: false });
});

test('terminal step: the module is built when it does not work; tmux alone is said plainly; nothing is built without the tools or in a dry run', async () => {
  const good = async () => ({ ok: true });
  const bad = async () => ({ ok: false, why: 'it does not load' });
  const tmuxBin = fakeBin(path.join(s.tmp, 'bin-tmux-step'), { tmux: 'echo "tmux 3.4"' });
  const toolsBin = fakeBin(path.join(s.tmp, 'bin-tools-step'), { make: 'exit 0', 'g++': 'exit 0', python3: 'exit 0' });
  const linux = (PATH) => sys({ PATH, platform: 'linux' });
  // works at once: nothing is built
  let u = ui();
  let builds = 0;
  const never = async () => { builds++; return { ok: false, why: 'x' }; };
  assert.equal(await SU.stepTerminal(u.ui, linux(pathWith(s.tmp)), good, never), true);
  assert.match(u.rec.text, /✓ Terminal: built-in/);
  assert.equal(builds, 0);
  // does not work, the build tools are there: setup builds it and checks again
  u = ui();
  const built = async () => { builds++; return good(); };
  assert.equal(await SU.stepTerminal(u.ui, linux(pathWith(s.tmp, toolsBin)), bad, built), true);
  assert.equal(builds, 1);
  assert.match(u.rec.text, /✓ Terminal: built-in/);
  // a dry run only says what it would run
  u = ui({ dryRun: true });
  await SU.stepTerminal(u.ui, linux(pathWith(s.tmp, toolsBin)), bad, never);
  assert.equal(builds, 1);
  assert.match(u.rec.text, /Would build the terminal module \(npm (rebuild node-pty|install --omit=dev --no-audit --no-fund)\)/);
  // no build tools on Linux: no build is tried; without tmux it fails with the command that installs them
  u = ui();
  assert.equal(await SU.stepTerminal(u.ui, linux(pathWith(s.tmp)), bad, never), false);
  assert.equal(builds, 1);
  assert.match(u.rec.text, /✗ Terminal: the built-in terminal does not work \(.*\)\. Fix: Install a C\+\+ compiler, make and python3 && cd ".*" && npm /);
  // with tmux setup goes on, and says what will not work
  u = ui();
  assert.equal(await SU.stepTerminal(u.ui, linux(pathWith(s.tmp, tmuxBin)), bad, never), true);
  assert.match(u.rec.text, /! Terminal: sessions run in tmux and take messages, but no terminal can open in the browser: the terminal module does not work \(.*\)\. Fix: /);
  assert.doesNotMatch(u.rec.text, /✓ Terminal/);
});
