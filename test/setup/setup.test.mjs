import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SHELL_STANDINS } from '../seal.mjs';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder, scratch, snapshot, windowsFacts } from './helpers.mjs';

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
  // A desktop at home unless a test says otherwise: the computer running the tests may be a server reached by ssh.
  for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[k];
  Object.assign(env, over.env || {});
  const has = (c) => c !== 'systemctl' && !!which(c, env, process.platform);
  const { PATH: _p, env: _e, ...rest } = over; // seal: a value no program is started with
  // run: Windows' whoami answers are facts here (not elevated), never the system's own (helpers.mjs windowsFacts).
  const made = K.sysInfo({ env, has, pm: null, root: false, serviceSupported: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, run: windowsFacts(env), ...rest });
  // Nothing listens for these tests, whatever really runs on this machine's dashboard port.
  made.probe = over.probe || (async () => 0);
  // A gateway program on this computer's PATH is not a copy for doctor to ask the default port about.
  made.ownGateways = false;
  return made;
}

const noQuestions = async (q) => {
  throw new Error(`unexpected question: ${q}`);
};
// The parts after the dashboard's steps (computer, project, skills) are tested in firstrun.test.mjs: here they do nothing.
const NOPARTS = {
  workspace: async () => ({ ok: true, changed: false }),
  git: async () => ({ ok: true, changed: false }),
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
  assert.deepEqual(SU.parseSetupArgs([]), { yes: false, dryRun: false, passwordFile: null, access: null, service: true, hub: false, domain: null, ip: null, tlsInternal: false, only: null, stayRoot: false, noDashboard: false });
  assert.deepEqual(SU.parseSetupArgs(['--yes', '--dry-run', '--password-file', 'p.txt', '--access', 'local', '--no-service']),
    { yes: true, dryRun: true, passwordFile: 'p.txt', access: 'local', service: false, hub: false, domain: null, ip: null, tlsInternal: false, only: null, stayRoot: false, noDashboard: false });
  assert.equal(SU.parseSetupArgs(['--stay-root']).stayRoot, true);
  assert.deepEqual(SU.parseSetupArgs(['--hub', '--domain', 'hub.example.com', '--tls-internal']).domain, 'hub.example.com');
  assert.equal(SU.parseSetupArgs(['--hub', '--ip=1.1.1.1']).ip, '1.1.1.1');
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
  for (const host of ['10.0.0.5', '100.101.102.103', '203.0.114.7', 'fd7a:115c::1']) assert.equal(SU.currentAccess({ server: { host } }, null), 'network', host);
  for (const host of ['localhost', '::1', '127.0.0.2']) assert.equal(SU.currentAccess({ server: { host } }, null), 'local', host);
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
  fs.rmSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true, force: true }); // a computer with no settings at all
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
  assert.doesNotMatch(rec.text, /A new terminal|open a new terminal/, 'nothing was added to PATH, so no new terminal is needed');
});

test('setup --dry-run with Claude Code missing: says it would install it, asks nothing, installs nothing', async () => {
  const empty = fakeBin(path.join(s.tmp, 'bin-empty'), {});
  const { ui: u, rec } = ui({ dryRun: true });
  await SU.setup(['--dry-run'], { ui: u, sys: sys({ PATH: pathWith(s.tmp, empty), platform: 'linux' }), parts: NOPARTS }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  assert.match(rec.text, /Claude Code is not installed\./);
  assert.match(rec.text, /Would install Claude Code with the official installer/);
  assert.doesNotMatch(rec.text, /Install it now/);
  assert.equal(fs.existsSync(path.join(process.env.HOME, '.local')), false);
});

test('Claude Code missing, switched off in Coding tools, no terminal: it is not installed and nothing restarts', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const empty = fakeBin(path.join(s.tmp, 'bin-empty-off'), {});
  saveConfig({ codingTools: ['opencode'] });
  try {
    const { ui: u, rec } = ui({});
    const state = { changed: false };
    assert.equal(await SU.stepClaude(u, sys({ PATH: pathWith(s.tmp, empty), platform: 'linux' }), state), false); // seal: only the test's own folders
    assert.doesNotMatch(rec.text, /Installing with the official installer/);
    assert.match(rec.text, /Install it now\? .*skipped: no terminal/);
    assert.equal(state.changed, false);
  } finally {
    saveConfig({ codingTools: ['claude'] });
  }
});

test('setup --yes: profile, password file, network access, no questions; a second run changes nothing', SHELL_STANDINS, async () => {
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
  // The dashboard's press first, in the page's own names; the command only as the other way.
  assert.match(first.rec.text, /^ {2}Add another provider: on the dashboard, Providers → Add provider \(or: hoprig add\)$/m);
  assert.match(first.rec.text, /^ {2}Check everything: on the dashboard, Computers → this computer → Health \(or: hoprig doctor\)$/m);
  assert.doesNotMatch(first.rec.text, /Check everything: hoprig doctor|Add another provider: hoprig add/);
  assert.ok(first.rec.text.split('\n').length < 60, 'fits on one screen');

  // Plain setup, interactive, everything decided: not one question.
  // Every run ends with a fresh one-time sign-in link, so that one file is expected to differ.
  const settled = () => JSON.parse(JSON.stringify(stateDirs(), (k, v) => (k === 'login-links.json' ? undefined : v)));
  const after = settled();
  const again = ui({ interactive: true });
  assert.equal(await SU.setup([], { ui: again.ui, sys: sys(), parts: NOPARTS }), 0, again.rec.text);
  assert.deepEqual(settled(), after, 'running setup again changed nothing');
});

test('--access changes the choice without a question; Tailscale uses tailscale serve', SHELL_STANDINS, async () => {
  const tsBin = fakeBin(path.join(s.tmp, 'bin-ts'), {
    tailscale: 'case "$1" in status) echo \'{"BackendState":"Running","Self":{"DNSName":"pc.tail1.ts.net."}}\' ;; serve) echo "serving $3" ;; esac',
  });
  const S2 = sys({ PATH: pathWith(s.tmp, bin, tsBin) }); // seal: only the test's own folders, in an environment that keeps the runner's variables
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

test('not logged in: one line, and setup goes on', SHELL_STANDINS, async () => {
  const nl = fakeBin(path.join(s.tmp, 'bin-nologin'), { claude: fakeClaude({ loggedIn: false }) });
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await SU.setup(['--yes'], { ui: u, sys: sys({ PATH: pathWith(s.tmp, nl) }), parts: NOPARTS }), 0); // seal: only the test's own folders, in an environment that keeps the runner's variables
  // The line keeps only its mark; its next step is in the one closing list, at the very end (G11).
  assert.match(rec.text, /^ {2}! No Claude account logged in$/m);
  const end = rec.text.slice(rec.text.indexOf('Still yours to do:'));
  assert.ok(rec.text.indexOf('Still yours to do:') > rec.text.indexOf('is ready'), 'after everything else');
  // (A first run in this home also lists the new terminal: set-up just put ~/.local/bin on PATH in its start files.)
  assert.deepEqual(end.trim().split('\n').slice(1).map((l) => l.trim()).filter((l) => !l.startsWith('· A new terminal')), ['· Sign in to Claude Code: On the dashboard: Home → Get started → Sign in to Claude. Or only here, on this computer: run claude, then type /login']);
  assert.equal(rec.text.split('type /login').length - 1, 1, `said once:\n${rec.text}`); // (the dashboard's own link has /login too)
});

test('one closing list "Still yours to do": every step that leaves something adds it once, and nothing of it comes earlier', SHELL_STANDINS, async () => {
  const nl = fakeBin(path.join(s.tmp, 'bin-nologin-g11'), { claude: fakeClaude({ loggedIn: false }) });
  const { ui: u, rec } = ui({ yes: true });
  // The Git and computer steps as set-up runs them, each leaving something (they say it twice, as two runs could).
  const { yours } = await import('../../src/setup/ui.mjs');
  const parts = {
    ...NOPARTS,
    git: async ({ ui: g }) => { yours(g, 'warn', 'commit name and e-mail not set', 'identity'); yours(g, 'info', 'GitHub: not signed in', 'github'); yours(g, 'warn', 'the GitHub sign-in did not finish', 'github'); return { ok: true, changed: false }; },
    pc: async ({ ui: g }) => { yours(g, 'warn', 'commit name and e-mail not set', 'identity'); g.todo('terminal'); return { ok: true, changed: false, missing: [], code: 0 }; },
  };
  assert.equal(await SU.setup(['--yes'], { ui: u, sys: sys({ PATH: pathWith(s.tmp, nl) }), parts }), 0); // seal: only the test's own folders, in an environment that keeps the runner's variables
  const at = rec.text.indexOf('Still yours to do:');
  assert.ok(at > 0, rec.text);
  assert.equal(rec.text.split('Still yours to do:').length, 2, 'one list');
  const list = rec.text.slice(at).trim().split('\n').slice(1).map((l) => l.trim());
  assert.deepEqual(list, [
    '· Your name and e-mail for commits: On the dashboard: Home → Get started → Set up git and GitHub. Or only here, on this computer: git config --global user.name "Your Name" && git config --global user.email you@example.com',
    '· Sign in to GitHub: On the dashboard: Home → Get started → Set up git and GitHub. Or only here, on this computer: gh auth login',
    '· Sign in to Claude Code: On the dashboard: Home → Get started → Sign in to Claude. Or only here, on this computer: run claude, then type /login',
    '· A new terminal, so every new program and the hoprig command are found: open a new terminal (or log in again)',
  ]);
  const before = rec.text.slice(0, at);
  for (const step of ['git config --global', 'gh auth login', 'type /login', 'open a new terminal']) assert.ok(!before.includes(step), `nothing of the list earlier: ${step}\n${before}`);
});

test('outside set-up a step still says its next step on its own line', async () => {
  const { yours } = await import('../../src/setup/ui.mjs');
  const { ui: u, rec } = ui();
  yours(u, 'warn', 'commit name and e-mail not set', 'identity');
  assert.match(rec.text, /! commit name and e-mail not set: git config --global user\.name "Your Name"/);
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
  const S3 = sys({ PATH: empty }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  const { ui: u, rec } = ui({ yes: true });
  const code = await SU.setup(['--hub', '--yes', '--no-service', '--access', 'local'], { ui: u, sys: S3 });
  assert.equal(code, 0, rec.text);
  assert.match(rec.text, /Main computer only: this computer shows your other computers/);
  assert.doesNotMatch(rec.text, /Claude Code is not installed|Install it now/);
  assert.equal(loadConfig().hubOnly, true);
  // The line to type on the other computers comes from machines/hubcert.mjs (it carries --fingerprint when the
  // hub's certificate is its own). A hub on this computer's own plain address needs neither that nor --insecure.
  assert.match(rec.text, /Connect each of your computers to it \(the code works once, for 10 minutes\): hoprig join http:\/\/127\.0\.0\.1:\d+ [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\n/);
  // The doctor agrees: nothing about Claude Code counts as a problem here.
  // (Its port check asks a free port, never the default one, where the computer running the tests may have its own.)
  saveConfig({ server: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } });
  const results = await K.allChecks({ sys: S3, offline: true });
  const claude = results.find((r) => r.id === 'claude');
  assert.deepEqual([claude.status, /not needed on a main computer/.test(claude.detail)], ['info', true]);
  saveConfig({ hubOnly: false });
});

test('doctor\'s port check uses the port the dashboard would really listen on, never the default where a real one may run', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const { configFile } = await import('../../src/paths.mjs');
  const asked = [];
  const probe = async (host, port) => (asked.push(port), 'ECONNREFUSED'); // no real connection
  const none = async () => null; // no dashboard runs now
  // saveConfig merges `server`, so it cannot take a port away: the file is written without one.
  const noPort = () => {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    cfg.server = { ...(cfg.server || {}) };
    delete cfg.server.port;
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  };
  saveConfig({ server: { port: 8601 } });
  // PORT in the environment wins over the settings (as it does for the server).
  await K.allChecks({ sys: sys({ env: { PORT: '8599' }, probe, running: none }), offline: true });
  assert.deepEqual(asked, [8599], 'by PORT');
  // Then the settings' port.
  asked.length = 0;
  await K.allChecks({ sys: sys({ env: { PORT: undefined }, probe, running: none }), offline: true });
  assert.deepEqual(asked, [8601], 'by settings');
  // Neither: the default would be asked (only the fake probe hears it).
  asked.length = 0;
  noPort();
  assert.equal(loadConfig().server.port, undefined, 'no port in the settings now');
  await K.allChecks({ sys: sys({ env: { PORT: undefined }, probe, running: none }), offline: true });
  assert.deepEqual(asked, [K.DEFAULT_PORT], 'neither: the default');
  // A PORT the server would itself refuse (0) is said, not probed: nothing is asked of 7433 or anything else.
  asked.length = 0;
  const r = await K.allChecks({ sys: sys({ env: { PORT: '0' }, probe, running: none }), offline: true });
  assert.equal(asked.length, 0, `invalid PORT probed: ${asked.join()}`);
  assert.equal(r.find((x) => x.id === 'port').status, 'warn');
  saveConfig({ server: { port: 8601 } });
});

test('doctor asks the port a running dashboard listens on, and its access line names the same port, whatever this shell\'s PORT says', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const asked = [];
  const probe = async (host, port) => (asked.push(port), 200);
  // The service runs on the settings' port; this shell set PORT for another program (the service does not carry it).
  saveConfig({ server: { port: 8302 } });
  const running = async () => ({ version: null, unknown: true, pid: 1, host: '127.0.0.1', port: 8302, backend: null, terminals: null });
  const r = await K.allChecks({ sys: sys({ env: { PORT: '8303' }, probe, running }), offline: true });
  assert.deepEqual(asked, [8302]);
  assert.equal(r.find((x) => x.id === 'port').detail, 'answers on 127.0.0.1:8302');
  assert.match(r.find((x) => x.id === 'access').detail, /127\.0\.0\.1:8302/);
  // The other way: it runs under a PORT of its own (a panel, a container), the settings say another, this shell none.
  asked.length = 0;
  const elsewhere = async () => ({ version: null, unknown: true, pid: 1, host: '127.0.0.1', port: 8304, backend: null, terminals: null });
  const r2 = await K.allChecks({ sys: sys({ env: { PORT: undefined }, probe, running: elsewhere }), offline: true });
  assert.deepEqual(asked, [8304]);
  assert.match(r2.find((x) => x.id === 'access').detail, /127\.0\.0\.1:8304/);
});

test('terminal step: the module is built when it does not work; tmux alone is said plainly; nothing is built without the tools or in a dry run', { skip: process.platform === 'win32' && 'the terminal step of Linux (tmux, the build tools) is handed in, and Linux PATH rules cannot read a Windows PATH' }, async () => {
  const good = async () => ({ ok: true });
  const bad = async () => ({ ok: false, why: 'it does not load' });
  const tmuxBin = fakeBin(path.join(s.tmp, 'bin-tmux-step'), { tmux: 'echo "tmux 3.4"' });
  // npm is on this PATH too: without it set-up would name the npm of its own Node (system.mjs: npmArgv).
  const toolsBin = fakeBin(path.join(s.tmp, 'bin-tools-step'), { make: 'exit 0', 'g++': 'exit 0', python3: 'exit 0', npm: 'exit 0' });
  const linux = (PATH) => sys({ PATH, platform: 'linux' }); // seal: only the test's own folders, in an environment that keeps the runner's variables
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
  assert.match(u.rec.text, /✗ Terminal: the built-in terminal does not work \(.*\)\. Fix: Install a C\+\+ compiler, make and python3 && cd '?[^"]*'? && npm /);
  // with tmux setup goes on, and says what will not work
  u = ui();
  assert.equal(await SU.stepTerminal(u.ui, linux(pathWith(s.tmp, tmuxBin)), bad, never), true);
  assert.match(u.rec.text, /! Terminal: sessions run in tmux and take messages, but no terminal can open in the browser: the terminal module does not work \(.*\)\. Fix: /);
  assert.doesNotMatch(u.rec.text, /✓ Terminal/);
});

test('the first profile is said through set-up\'s own lines, without claiming a Claude login', async () => {
  const dir = path.join(process.env.HOPRIG_CONFIG_DIR, 'profiles');
  const keep = path.join(s.tmp, 'profiles-kept');
  if (fs.existsSync(dir)) fs.renameSync(dir, keep);
  const { ui: u, rec } = ui({ yes: true });
  const direct = [];
  const write = process.stdout.write;
  // Passed on: the test runner reports through stdout too.
  process.stdout.write = (c, ...a) => (direct.push(String(c)), write.call(process.stdout, c, ...a));
  try {
    assert.equal(await SU.stepProfile(u), true);
  } finally {
    process.stdout.write = write;
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(keep)) fs.renameSync(keep, dir);
  }
  assert.equal(direct.filter((c) => c.includes('Created the profile')).length, 0, 'nothing past set-up\'s ui');
  assert.equal(rec.text, '  ✓ Created the profile "sub" (this computer\'s Claude login)\n');
});
