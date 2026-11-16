import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Every location goes to a scratch folder BEFORE the modules read the environment.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-test-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { binFile, hookFile, profilesDir, runsDir } = await import('../src/paths.mjs');
const P = await import('../src/profiles.mjs');
const R = await import('../src/runs.mjs');
const S = await import('../src/sessions.mjs');
const L = await import('../src/launch.mjs');
const M = await import('../src/menu.mjs');

test('parseEnv reads plain, quoted, exported and commented lines', () => {
  const env = P.parseEnv(['# note', 'A=1', 'export B="two words"', "C='x$y'", 'D="q\\"uote"', 'bad line', '1X=no', 'E=', ''].join('\n'));
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x$y', D: 'q"uote', E: '' });
});

test('a profile round-trips through its file, values intact, file private', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'a b"c$d`e\\f' };
  P.writeProfile('api', { label: 'API via proxy', prerun: 'proxy start --port 1234', env });
  const p = P.readProfile('api');
  assert.equal(p.label, 'API via proxy');
  assert.equal(p.prerun, 'proxy start --port 1234');
  assert.equal(p.kind, 'api');
  assert.deepEqual(p.env, env);
  assert.equal(fs.statSync(path.join(profilesDir(), 'api.env')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(profilesDir()).mode & 0o777, 0o700);
});

test('kinds: login, subscription, api', () => {
  P.writeProfile('sub', {});
  P.writeProfile('sub2', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } });
  assert.equal(P.readProfile('sub').kind, 'login');
  assert.equal(P.readProfile('sub2').kind, 'subscription');
  assert.deepEqual(P.listProfiles().map((p) => p.name), ['api', 'sub', 'sub2']);
});

test('publicProfile carries no value', () => {
  const pub = P.publicProfile(P.readProfile('sub2'));
  assert.deepEqual(Object.keys(pub).sort(), ['kind', 'label', 'name', 'paid', 'tools']);
  assert.deepEqual(pub.tools, ['claude'], 'a subscription serves Claude Code only');
  assert.ok(!JSON.stringify(pub).includes('sk-ant'));
});

test('names: command words and odd characters are refused', () => {
  for (const bad of ['add', 'run', 'x', 'stop', 'A', '../x', 'a b', '', '-c', 'a'.repeat(33)]) assert.equal(P.validName(bad), false, bad);
  for (const ok of ['sub', 'sub2', 'work-api', 'a_b']) assert.equal(P.validName(ok), true, ok);
  assert.throws(() => P.writeProfile('add', {}));
  assert.throws(() => P.writeProfile('ok', { env: { 'BAD KEY': '1' } }));
  assert.throws(() => P.writeProfile('ok', { env: { A: 'line\nbreak' } }));
  assert.equal(P.readProfile('../api'), null);
});

test('profileEnv clears every auth variable of the surrounding shell, then applies the profile', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_BASE_URL: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'old' };
  const login = P.profileEnv(P.readProfile('sub'), base);
  for (const k of P.AUTH_VARS) assert.equal(k in login, false, k);
  assert.equal(login.PATH, '/bin');
  assert.equal(login.HOPRIG_PROFILE, 'sub');
  const sub2 = P.profileEnv(P.readProfile('sub2'), base);
  assert.equal(sub2.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-x');
  assert.equal('ANTHROPIC_API_KEY' in sub2, false);
  assert.equal(base.ANTHROPIC_API_KEY, 'old', 'the caller\'s object is not changed');
});

test('deleteProfile', () => {
  P.writeProfile('gone', {});
  assert.equal(P.deleteProfile('gone'), true);
  assert.equal(P.deleteProfile('gone'), false);
  assert.equal(P.readProfile('gone'), null);
});

test('carryArgs keeps how Claude runs and drops the session choice, prompts and one-off flags', () => {
  assert.deepEqual(
    L.carryArgs(['--effort', 'high', '--permission-mode', 'bypassPermissions', '-c', 'fix the bug']),
    ['--effort', 'high', '--permission-mode', 'bypassPermissions'],
  );
  assert.deepEqual(L.carryArgs(['--resume', 'abc', '--model=opus', '--fork-session', '--verbose']), ['--model=opus', '--verbose']);
  assert.deepEqual(L.carryArgs(['--add-dir', '/a', '/b', '--session-id', 'x', '-p']), ['--add-dir', '/a', '/b']);
  assert.deepEqual(L.carryArgs(['--model']), []);
  assert.deepEqual(L.carryArgs(['--unknown', 'v', '--dangerously-skip-permissions']), ['--dangerously-skip-permissions']);
});

test('a resume starts on this profile\'s model, never on the one named in the transcript', () => {
  const login = { env: {} };
  const pinned = { env: { ANTHROPIC_MODEL: 'opus' } };
  // New session: Claude Code's own choice. Resume: the default, unless --model or the profile decides.
  assert.deepEqual(L.modelArgs(login, ['--effort', 'high']), []);
  assert.deepEqual(L.modelArgs(login, ['-c']), ['--model', 'default']);
  assert.deepEqual(L.modelArgs(login, ['--resume', 'id', '--model', 'sonnet']), []);
  assert.deepEqual(L.modelArgs(login, ['--resume=id', '--model=sonnet']), []);
  assert.deepEqual(L.modelArgs(pinned, ['--resume', 'id']), []);
  // The user's own default model in Claude Code's settings is respected.
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-2' }));
  assert.deepEqual(L.modelArgs(login, ['-c']), ['--model', 'claude-fable-5-2']);
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
});

test('moveArgs: the chosen model moves along, except to a profile that names its own', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const args = ['--effort', 'high', '--model', 'sonnet', '-c', 'do it'];
  assert.deepEqual(L.moveArgs({ env: {} }, args, id), ['--effort', 'high', '--model', 'sonnet', '--resume', id]);
  assert.deepEqual(L.moveArgs({ env: { ANTHROPIC_MODEL: 'opus' } }, args, id), ['--effort', 'high', '--resume', id]);
  assert.deepEqual(L.moveArgs({ env: { ANTHROPIC_MODEL: 'opus' } }, ['--model=sonnet', '--verbose'], id), ['--verbose', '--resume', id]);
});

test('moveArgs: a session nobody typed into starts under its id; one with a conversation resumes it', () => {
  // Claude Code writes a conversation's file with its first message. Before that `--resume <id>` ends with
  // "No conversation found with session ID": moving such a session failed, and failed again from the menu.
  const id = '22222222-2222-4222-8222-222222222222';
  const cwd = path.join(tmp, 'fresh-proj');
  assert.equal(S.hasConversation(cwd, id), false);
  assert.deepEqual(L.moveArgs({ env: {} }, ['--effort', 'high', 'a prompt'], id, { fresh: !S.hasConversation(cwd, id) }), ['--effort', 'high', '--session-id', id]);
  assert.deepEqual(L.carryArgs(['--effort', 'high', '--session-id', id]), ['--effort', 'high'], 'the next move decides again');
  fs.mkdirSync(S.projectDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(S.projectDir(cwd), `${id}.jsonl`), '{"type":"user","message":{"content":"hi"}}\n');
  assert.equal(S.hasConversation(cwd, id), true);
  assert.deepEqual(L.moveArgs({ env: {} }, ['--effort', 'high'], id, { fresh: !S.hasConversation(cwd, id) }), ['--effort', 'high', '--resume', id]);
  // A conversation kept under another folder is still one to resume; an id that is no id is none.
  assert.equal(S.hasConversation(path.join(tmp, 'elsewhere'), id), true);
  assert.equal(S.hasConversation(cwd, '../x'), false);
  assert.equal(S.hasConversation(cwd, '33333333-3333-4333-8333-333333333333'), false);
});

test('session and print flags are recognised', () => {
  assert.equal(L.hasSessionFlag(['--effort', 'high']), false);
  for (const a of [['-c'], ['--continue'], ['-r'], ['--resume', 'id'], ['--resume=id'], ['--session-id', 'x']]) assert.equal(L.hasSessionFlag(a), true, a.join(' '));
  assert.equal(L.isPrintMode(['-p', 'hi']), true);
  assert.equal(L.isPrintMode(['hi']), false);
});

test('hook settings call the small hook program for the six events; the status line only when a script is given', () => {
  const s = L.hookSettings();
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  assert.equal('statusLine' in s, false);
  assert.deepEqual(L.hookSettings({ statusScript: '/x/y.sh', padding: 1 }).statusLine, { type: 'command', command: process.platform === 'win32' ? 'sh "/x/y.sh"' : "sh '/x/y.sh'", padding: 1 });
  const cmd = s.hooks.Stop[0].hooks[0].command;
  assert.ok(cmd.includes(process.execPath) && cmd.includes(hookFile()), cmd);
  assert.ok(fs.existsSync(hookFile()), 'the program the settings name is there');
});

test('menu choice: number, name, and the c / r suffix; an exact name wins', () => {
  const profiles = [{ name: 'abc' }, { name: 'api' }, { name: 'sub2' }];
  const pick = (a) => { const c = M.parseChoice(a, profiles); return c && `${c.profile.name}:${c.mode}`; };
  assert.equal(pick('2'), 'api:new');
  assert.equal(pick('2c'), 'api:continue');
  assert.equal(pick('3r'), 'sub2:pick');
  assert.equal(pick('api'), 'api:new');
  assert.equal(pick('apic'), 'api:continue');
  assert.equal(pick('abc'), 'abc:new');
  assert.equal(pick('SUB2R'), 'sub2:pick');
  assert.equal(pick('9'), null);
  assert.equal(pick('0'), null);
  assert.equal(pick('nope'), null);
});

test('project slug matches Claude Code', () => {
  assert.equal(S.projectSlug('/home/alex/Workspace/projects'), '-home-alex-Workspace-projects');
  assert.equal(S.projectSlug('/tmp/cc-switch-test.SSekMM'), '-tmp-cc-switch-test-SSekMM');
});

test('sessionsIn lists a folder\'s sessions newest first; sessionTitle finds the first real prompt', () => {
  const cwd = '/work/my.app';
  const dir = S.projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(dir, `${a}.jsonl`),
    line({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>x</local-command-caveat>' } }) +
    line({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the   login\nbug' }] } }));
  fs.writeFileSync(path.join(dir, `${b}.jsonl`), line({ type: 'summary', summary: 'Checkout redesign' }) + line({ type: 'user', message: { content: 'hello' } }));
  fs.writeFileSync(path.join(dir, 'agent-xyz.jsonl'), '{}\n');
  fs.utimesSync(path.join(dir, `${a}.jsonl`), new Date(1e12), new Date(1e12));
  fs.utimesSync(path.join(dir, `${b}.jsonl`), new Date(2e12), new Date(2e12));
  const list = S.sessionsIn(cwd);
  assert.deepEqual(list.map((s) => s.id), [b, a]);
  assert.equal(S.sessionTitle(list[0].file), 'Checkout redesign');
  assert.equal(S.sessionTitle(list[1].file), 'Fix the login bug');
  assert.deepEqual(S.sessionsIn('/nowhere'), []);
});

test('runs: created, updated, listed while the launcher lives, dropped when it is gone', () => {
  const { file, run } = R.createRun({ profile: 'api', cwd: '/w', carryArgs: ['--effort', 'high'] });
  assert.equal(run.status, 'starting');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const next = R.updateRun(file, { status: 'working', sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(next.status, 'working');
  assert.deepEqual(R.listRuns().map((r) => r.runId), [run.runId]);
  // A run whose launcher is dead is removed from disk.
  const dead = path.join(runsDir(), 'dead.json');
  fs.writeFileSync(dead, JSON.stringify({ ...run, runId: 'dead', pid: 2 ** 22 + 12345 }));
  assert.deepEqual(R.listRuns().map((r) => r.runId), [run.runId]);
  assert.equal(fs.existsSync(dead), false);
  R.removeRun(file);
  assert.equal(R.updateRun(file, { status: 'ended' }), null);
  assert.deepEqual(R.listRuns(), []);
});

test('`hoprig hook` writes the session id and state into the run file, silently', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const id = '33333333-3333-4333-8333-333333333333';
  const hook = (ev) => spawnSync(process.execPath, [binFile(), 'hook'], {
    input: JSON.stringify(ev), env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8',
  });
  let r = hook({ hook_event_name: 'SessionStart', session_id: id });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual([R.readRun(file).sessionId, R.readRun(file).status], [id, 'waiting']);
  hook({ hook_event_name: 'UserPromptSubmit', session_id: id });
  assert.equal(R.readRun(file).status, 'working');
  hook({ hook_event_name: 'Notification', session_id: id, message: 'Claude needs your permission' });
  assert.deepEqual([R.readRun(file).status, R.readRun(file).note], ['attention', 'Claude needs your permission']);
  hook({ hook_event_name: 'Stop', session_id: id });
  assert.deepEqual([R.readRun(file).status, R.readRun(file).note], ['waiting', '']);
  // Garbage in, nothing out, nothing broken.
  r = spawnSync(process.execPath, [binFile(), 'hook'], { input: 'not json', env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(R.readRun(file).sessionId, id);
  R.removeRun(file);
});

test('launch: a fake Claude gets the profile environment, the arguments and the hook settings; the exit code comes back', () => {
  const fake = path.join(tmp, 'fake-claude.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const settingsFile = process.argv[process.argv.indexOf('--settings') + 1];
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), settingsFile, settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')), env: {
  key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.ANTHROPIC_AUTH_TOKEN ?? null, base: process.env.ANTHROPIC_BASE_URL ?? null,
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, profile: process.env.HOPRIG_PROFILE, run: fs.existsSync(process.env.HOPRIG_RUN_FILE), pre: fs.existsSync(process.env.FAKE_OUT + '.pre') } }));
process.exit(7);
`, { mode: 0o755 });
  const outFile = path.join(tmp, 'fake-out.json');
  fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ claudeBin: fake, claudeArgs: ['--permission-mode', 'plan'] }));
  P.writeProfile('api', { prerun: 'echo proxy is up; touch "$FAKE_OUT.pre"', env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'tok' } });
  const r = spawnSync(process.execPath, [binFile(), 'api', '--effort', 'high', '-c'], {
    env: { ...process.env, FAKE_OUT: outFile, ANTHROPIC_API_KEY: 'from-shell', CLAUDE_CODE_OAUTH_TOKEN: 'from-shell' }, encoding: 'utf8',
  });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stdout, '', 'what PRERUN prints never lands on stdout, which is Claude Code\'s alone');
  assert.match(r.stderr, /proxy is up/);
  const got = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(got.env, { key: null, token: 'tok', base: 'http://localhost:1234', oauth: null, profile: 'api', run: true, pre: true });
  assert.deepEqual(got.args.slice(0, 8), ['--permission-mode', 'plan', '--effort', 'high', '-c', '--model', 'default', '--settings']);
  assert.ok(got.settings.hooks.SessionStart, 'the hooks arrive as a settings file');
  assert.equal(fs.existsSync(got.settingsFile), false, 'and the file is removed when Claude exits');
  assert.deepEqual(R.listRuns(), [], 'the run file is removed when Claude exits');
  // A provider that does not serve Claude Code (an OpenAI key) is refused before anything starts.
  P.writeProfile('oai', { env: { OPENAI_API_KEY: 'sk-not-for-claude' } });
  fs.rmSync(outFile, { force: true });
  const oai = spawnSync(process.execPath, [binFile(), 'oai'], { env: { ...process.env, FAKE_OUT: outFile }, encoding: 'utf8' });
  assert.equal(oai.status, 2);
  assert.match(oai.stderr, /does not serve Claude Code \(it works with: opencode\)/, 'only the offered coding tools are named');
  assert.equal(fs.existsSync(outFile), false, 'Claude Code was not started');
  P.deleteProfile('oai');
  // An unknown profile is an error, not a launch.
  const bad = spawnSync(process.execPath, [binFile(), 'run', 'nope'], { env: process.env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no profile "nope"/);
  fs.rmSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'));
});

test('profiles command: tab-separated and JSON, never a value', () => {
  const tsv = spawnSync(process.execPath, [binFile(), 'profiles'], { env: process.env, encoding: 'utf8' });
  assert.equal(tsv.status, 0);
  assert.match(tsv.stdout, /^api\tapi\t/m);
  assert.match(tsv.stdout, /^sub2\tsubscription\t/m);
  const json = spawnSync(process.execPath, [binFile(), 'profiles', '--json'], { env: process.env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(json.stdout).map((p) => p.name), ['api', 'sub', 'sub2']);
  assert.ok(!/tok|sk-ant/.test(tsv.stdout + json.stdout));
});

const A = await import('../src/autoswitch.mjs');

test('auto-switch: off and empty by default; settings are validated', () => {
  assert.deepEqual(A.getAutoSwitch(), { enabled: false, order: [], payPerUse: false, returnToPreferred: false, prompt: 'Continue from where you stopped.', cooldownMinutes: 300 });
  assert.throws(() => A.setAutoSwitch({ order: ['sub', 'nope'] }), /no profile "nope"/);
  assert.throws(() => A.setAutoSwitch({ prompt: 'two\nlines' }));
  assert.throws(() => A.setAutoSwitch({ cooldownMinutes: 0 }));
  const set = A.setAutoSwitch({ enabled: true, order: ['sub', 'sub2', 'api', 'sub'], returnToPreferred: true });
  assert.deepEqual([set.enabled, set.order, set.returnToPreferred], [true, ['sub', 'sub2', 'api'], true]);
  assert.deepEqual(A.getAutoSwitch().order, ['sub', 'sub2', 'api']);
});

test('auto-switch: the next profile follows the order, goes round, and skips profiles at their limit', () => {
  const now = 1_800_000_000_000;
  assert.equal(A.nextProfile('sub', now), 'sub2');
  assert.equal(A.nextProfile('api', now), 'sub');
  assert.equal(A.nextProfile('not-in-order', now), 'sub');
  assert.equal(A.preferredAvailable('api', now), 'sub');
  assert.equal(A.preferredAvailable('sub', now), null);
  assert.equal(A.recommendedProfile(now), 'sub');
  // sub hits its limit with a known end; sub2 with none (the cooldown applies).
  const until = now + 2 * 3600_000;
  assert.deepEqual([A.markLimited('sub', { until, reason: 'rate_limit', text: 'x' }, now).exact, A.markLimited('sub2', {}, now).exact], [true, false]);
  assert.equal(A.limitedProfiles(now).sub2.until, now + 300 * 60_000);
  assert.equal(A.nextProfile('sub', now), 'api');
  assert.equal(A.nextProfile('api', now), null, 'everything else is at its limit: stay');
  assert.equal(A.preferredAvailable('api', now), null);
  assert.equal(A.recommendedProfile(now), 'api');
  // Two hours later sub is free again, sub2 still not.
  const later = until + 1;
  assert.deepEqual(Object.keys(A.limitedProfiles(later)), ['sub2']);
  assert.equal(A.preferredAvailable('api', later), 'sub');
  assert.equal(A.nextProfile('api', later), 'sub');
  assert.equal(A.clearLimited('sub2'), true);
  assert.equal(A.clearLimited('sub2'), false);
  // A provider in the order that does not serve Claude Code (an OpenAI key) is never one Auto mode moves to.
  P.writeProfile('oai', { env: { OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'http://localhost:1' } });
  A.setAutoSwitch({ order: ['oai', 'sub', 'sub2', 'api'] });
  assert.deepEqual(A.usableOrder(), ['sub', 'sub2', 'api']);
  assert.equal(A.recommendedProfile(later), 'sub');
  P.deleteProfile('oai');
  A.setAutoSwitch({ enabled: false, order: [], returnToPreferred: false });
});

test('pay-per-use: an Anthropic API key straight to Anthropic; a gateway, a proxy or a subscription is not', () => {
  assert.equal(P.isPayPerUse({ ANTHROPIC_API_KEY: 'k' }), true);
  assert.equal(P.isPayPerUse({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), true);
  assert.equal(P.isPayPerUse({ ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }), true);
  assert.equal(P.isPayPerUse({ ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'http://localhost:20017' }), false, 'TRouteAI');
  assert.equal(P.isPayPerUse({ ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'https://office.example.net:7433/gw' }), false, 'a gateway on another computer');
  assert.equal(P.isPayPerUse({ ANTHROPIC_BASE_URL: 'http://localhost:1234' }), false, 'an address without a key');
  assert.equal(P.isPayPerUse({ CLAUDE_CODE_OAUTH_TOKEN: 't' }), false);
  assert.equal(P.isPayPerUse({}), false);
  assert.equal(P.isPayPerUse({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'not an address' }), true, 'unreadable: the safe side');
  assert.equal(P.readProfile('api').paid, false, 'the test profile goes through a proxy');
});

test('auto-switch: a pay-per-use key is used only when allowed; an existing order that holds one keeps it', async () => {
  const { loadConfig, saveConfig } = await import('../src/config.mjs');
  const now = 1_800_000_000_000;
  P.writeProfile('key', { label: 'Key', env: { ANTHROPIC_API_KEY: 'demo-not-a-key' } });
  try {
    // An owner from before the choice existed, with the key in the order: nothing changes for them.
    saveConfig({ autoSwitch: { enabled: true, order: ['sub', 'key'] } });
    assert.equal(A.getAutoSwitch().payPerUse, true, 'never chosen, and the order holds a paid key: on');
    assert.deepEqual(A.usableOrder(), ['sub', 'key']);
    assert.equal(A.nextProfile('sub', now), 'key');
    A.setAutoSwitch({ returnToPreferred: true });
    assert.equal('payPerUse' in loadConfig().autoSwitch, false, 'another change does not make the choice for them');
    assert.deepEqual(loadConfig().autoSwitch.order, ['sub', 'key']);
    // Never chosen, no paid key in the order: off, and a key put there by hand in the file is skipped.
    saveConfig({ autoSwitch: { enabled: true, order: ['sub', 'sub2', 'api'] } });
    assert.equal(A.getAutoSwitch().payPerUse, false);
    saveConfig({ autoSwitch: { enabled: true, order: ['sub', 'sub2', 'api', 'key'], payPerUse: false } });
    assert.deepEqual(A.usableOrder(), ['sub', 'sub2', 'api'], 'the gateway stays, the paid key goes');
    A.markLimited('sub', {}, now);
    A.markLimited('sub2', {}, now);
    A.markLimited('api', {}, now);
    assert.equal(A.nextProfile('sub', now), null, 'everything free is paid: stay');
    A.clearLimited('api');
    assert.equal(A.nextProfile('sub', now), 'api');
    // Turning it on adds the paid keys at the end; off takes them out again.
    saveConfig({ autoSwitch: { enabled: true, order: ['sub', 'api'] } });
    assert.deepEqual(A.setAutoSwitch({ payPerUse: true }).order, ['sub', 'api', 'key']);
    assert.equal(A.nextProfile('api', now), 'key');
    assert.deepEqual(A.setAutoSwitch({ payPerUse: false }).order, ['sub', 'api']);
    assert.equal(loadConfig().autoSwitch.payPerUse, false, 'an explicit choice is kept');
    assert.equal(A.setAutoSwitch({ order: ['sub', 'key'] }).payPerUse, true, 'putting a paid key in the order is choosing it');
  } finally {
    A.clearLimited('sub');
    A.clearLimited('sub2');
    P.deleteProfile('key');
    saveConfig({ autoSwitch: {} });
  }
});

test('parseResets reads the forms Claude Code prints, in the zone it names', () => {
  const now = Date.UTC(2026, 10, 14, 10, 0); // 14 Nov 2026 10:00 UTC = 15:30 in Kolkata
  const at = (...a) => Date.UTC(...a);
  assert.equal(A.parseResets("You've hit your 5-hour limit · resets 5pm (UTC)", now), at(2026, 10, 14, 17, 0));
  assert.equal(A.parseResets('resets 9am (UTC)', now), at(2026, 10, 15, 9, 0), 'already past today: tomorrow');
  assert.equal(A.parseResets('resets 5:30pm (Asia/Kolkata)', now), at(2026, 10, 14, 12, 0));
  assert.equal(A.parseResets('resets at 12am (UTC)', now), at(2026, 10, 15, 0, 0));
  assert.equal(A.parseResets('weekly limit · resets Nov 18, 9am (UTC)', now), at(2026, 10, 18, 9, 0));
  assert.equal(A.parseResets('resets Jan 2, 9am (UTC)', Date.UTC(2026, 11, 30, 10, 0)), at(2027, 0, 2, 9, 0));
  assert.equal(A.parseResets('resets 3pm (America/New_York)', now), at(2026, 10, 14, 20, 0));
  assert.equal(A.parseResets('resets 5pm (Not/AZone)', now) > now, true, 'an unknown zone falls back to the local one');
  for (const bad of ['no time here', 'resets soon', 'resets 25pm', '', null]) assert.equal(A.parseResets(bad, now), null);
});

test('hooks: a rate limit is recorded on the run, the next prompt clears it, Stop keeps what Claude said', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const id = '44444444-4444-4444-8444-444444444444';
  const hook = (ev) => spawnSync(process.execPath, [binFile(), 'hook'], { input: JSON.stringify({ session_id: id, ...ev }), env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 5pm (UTC)" });
  let run = R.readRun(file);
  assert.deepEqual([run.status, run.limit.error, run.limit.text], ['attention', 'rate_limit', "You've hit your 5-hour limit · resets 5pm (UTC)"]);
  hook({ hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: 500' });
  assert.equal(R.readRun(file).limit.error, 'rate_limit', 'a server error is not a limit and does not overwrite one');
  hook({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(R.readRun(file).limit, null);
  hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.\n\nAll  tests pass.' });
  run = R.readRun(file);
  assert.deepEqual([run.status, run.lastMessage, typeof run.stopAt], ['waiting', 'Done. All tests pass.', 'number']);
  R.removeRun(file);
});

test('usage: the status data Claude Code hands the status line is read back per run', () => {
  const { file, run } = R.createRun({ profile: 'sub', cwd: '/w' });
  assert.equal(R.readUsage(file), null);
  fs.writeFileSync(R.usageFile(file), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 61.6, resets_at: 1800000000 }, seven_day: { used_percentage: 12 } } }));
  assert.deepEqual(R.readUsage(file), { fiveHour: { pct: 62, resetsAt: 1800000000000 }, week: { pct: 12, resetsAt: null } });
  assert.deepEqual(R.listRuns().find((r) => r.runId === run.runId).usage.fiveHour.pct, 62);
  fs.writeFileSync(R.usageFile(file), JSON.stringify({ rate_limits: null }));
  assert.equal(R.readUsage(file), null, 'an API profile has no plan limits');
  R.removeRun(file);
  assert.equal(fs.existsSync(R.usageFile(file)), false);
});

test('the status line script saves the data and runs the user\'s own status line on the same input', { skip: process.platform === 'win32' }, () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const script = path.join(tmp, 'sl.sh');
  const input = JSON.stringify({ model: { display_name: 'X' }, rate_limits: { five_hour: { used_percentage: 5 } }, note: 'a\\b "q" $HOME' });
  fs.writeFileSync(script, L.statusScript({ command: "sed 's/.*display_name\":\"\\([^\"]*\\).*/model \\1/'" }));
  let r = spawnSync('sh', [script], { input, env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'model X');
  assert.equal(fs.readFileSync(R.usageFile(file), 'utf8'), input, 'saved byte for byte');
  fs.writeFileSync(script, L.statusScript(null));
  r = spawnSync('sh', [script], { input, env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout], [0, ''], 'no status line of their own: nothing is printed');
  R.removeRun(file);
});

test('dedupeFlags keeps the last of a repeated single-value flag', () => {
  assert.deepEqual(L.dedupeFlags(['--effort', 'high', '--permission-mode', 'plan', '--effort', 'xhigh', '--verbose', '--effort=low', 'do it']),
    ['--permission-mode', 'plan', '--verbose', '--effort=low', 'do it']);
  assert.deepEqual(L.dedupeFlags(['--add-dir', '/a', '--add-dir', '/b']), ['--add-dir', '/a', '--add-dir', '/b'], 'list flags may repeat');
  assert.deepEqual(L.dedupeFlags(['-c']), ['-c']);
});

test('auto command: shows and changes the settings; "auto" is offered as a profile once an order is set', () => {
  const run = (...a) => spawnSync(process.execPath, [binFile(), 'auto', ...a], { env: process.env, encoding: 'utf8' });
  const names = () => JSON.parse(spawnSync(process.execPath, [binFile(), 'profiles', '--json'], { env: process.env, encoding: 'utf8' }).stdout).map((p) => p.name);
  assert.match(run('status').stdout, /Auto mode: off/);
  assert.equal(names().includes('auto'), false);
  assert.match(run('order', 'sub', 'api').stdout, /Order: +sub → api/);
  assert.deepEqual(names()[0], 'auto');
  // the line says what is true: with Auto mode off it does not promise that sessions move on by themselves
  const autoLine = () => spawnSync(process.execPath, [binFile(), 'profiles'], { env: process.env, encoding: 'utf8' }).stdout.split('\n')[0];
  assert.equal(autoLine(), 'auto\tauto\tsub → api  (Auto mode is off: only a session started as "auto" by name moves on at a limit)');
  assert.match(run('on').stdout, /Auto mode: on/);
  assert.equal(autoLine(), 'auto\tauto\tsub → api  (moves on at a limit, without stopping)');
  assert.equal(run('order', 'sub', 'ghost').status, 1);
  assert.match(run('off').stdout, /Auto mode: off/);
  A.setAutoSwitch({ order: [] });
  // Without an order Auto mode cannot start, and says how to set one.
  const bare = run();
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /needs the order of providers/);
});

const W = await import('../src/winspawn.mjs');

test('Windows: a bare command name is found like Windows finds it, .exe before .cmd', () => {
  const files = new Set(['C:\\Users\\me\\.local\\bin\\claude.exe', 'C:\\npm\\claude.cmd', 'C:\\npm\\other.cmd']);
  const exists = (p) => files.has(p);
  const env = { Path: 'C:\\npm;C:\\Users\\me\\.local\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(W.resolveWindowsBin('claude', env, exists), 'C:\\npm\\claude.cmd', 'the first PATH folder that has it wins');
  assert.equal(W.resolveWindowsBin('claude', { ...env, Path: 'C:\\Users\\me\\.local\\bin;C:\\npm' }, exists), 'C:\\Users\\me\\.local\\bin\\claude.exe');
  assert.equal(W.resolveWindowsBin('other', env, exists), 'C:\\npm\\other.cmd');
  assert.equal(W.resolveWindowsBin('C:\\npm\\claude.cmd', env, exists), 'C:\\npm\\claude.cmd');
  assert.equal(W.resolveWindowsBin('nothing', env, exists), null);
});

test('Windows: an .exe starts directly; a .cmd goes through cmd.exe with every argument escaped', () => {
  const exe = W.windowsSpawnPlan('C:\\bin\\claude.exe', ['--resume', 'id', 'say "hi" & exit'], {});
  assert.deepEqual(exe, { command: 'C:\\bin\\claude.exe', args: ['--resume', 'id', 'say "hi" & exit'], options: {} });
  const cmd = W.windowsSpawnPlan('C:\\Program Files\\npm\\claude.cmd', ['--effort', 'high', 'say "hi" & del %TEMP%'], { ComSpec: 'C:\\Windows\\cmd.exe' });
  assert.equal(cmd.command, 'C:\\Windows\\cmd.exe');
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  const line = cmd.args[3];
  assert.ok(line.startsWith('"C:\\Program^ Files\\npm\\claude.cmd '), line);
  // No cmd metacharacter of the prompt is left unescaped: every one is preceded by a caret.
  const tail = line.slice(line.indexOf('claude.cmd') + 'claude.cmd'.length, -1);
  assert.equal(/(^|[^^])[&%"<>|]/.test(tail), false, tail);
  assert.equal(W.cmdArgument('a b', false), '^"a^ b^"');
  assert.equal(W.cmdArgument('C:\\dir\\', false), '^"C:\\dir\\\\^"', 'a trailing backslash is doubled before the closing quote');
});

test('Auto mode runs as the first subscription that is free; an expired login or a limit moves it to the next', async () => {
  // A stand-in router answers the launcher's "are you there" call, so no real router is started.
  const http = await import('node:http');
  const { routerAddress } = await import('../src/routerstate.mjs');
  const { saveConfig } = await import('../src/config.mjs');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    saveConfig({ router: { port } });
    const url = routerAddress().url;
    for (const n of ['sub', 'sub2', 'api']) A.clearLimited(n);
    A.setAutoSwitch({ order: ['sub', 'sub2', 'api'] });
    const yes = async () => ({ loggedIn: true });
    const no = async () => ({ loggedIn: false });
    const logged = await L.autoProfile({ loginStatus: yes });
    assert.deepEqual([logged.name, logged.identity, logged.env.ANTHROPIC_BASE_URL, 'CLAUDE_CODE_OAUTH_TOKEN' in logged.env], ['auto', 'sub', `${url}/as/sub`, false]);
    const out = await L.autoProfile({ loginStatus: no });
    assert.deepEqual([out.identity, out.env.ANTHROPIC_BASE_URL, out.env.CLAUDE_CODE_OAUTH_TOKEN], ['sub2', `${url}/as/sub2`, 'sk-ant-oat01-x']);
    // sub at its limit: Claude Code itself runs as sub2 (its own token, used by Claude Code and by nothing else).
    A.markLimited('sub', { until: Date.now() + 3600_000 });
    assert.equal((await L.autoProfile({ loginStatus: yes })).identity, 'sub2');
    assert.equal(L.autoMove('sub', 'limit'), 'sub2', 'a session running as sub is restarted as sub2');
    assert.equal(L.autoMove('sub2', 'limit'), null, 'sub2 itself is not at its limit');
    assert.equal(L.autoMove('sub2', 'return'), null, 'sub is still at its limit: stay');
    A.clearLimited('sub');
    assert.equal(L.autoMove('sub2', 'return'), 'sub', 'sub is free again: go back between replies');
    assert.equal(L.autoMove('sub', 'return'), null);
    assert.equal(L.autoMove('sub', 'limit'), null, 'no move without a limit');
    // Both subscriptions at their limit: stay (the router uses the API account without a restart).
    A.markLimited('sub', { until: Date.now() + 3600_000 });
    A.markLimited('sub2', { until: Date.now() + 3600_000 });
    assert.equal(L.autoMove('sub', 'limit'), null);
    for (const n of ['sub', 'sub2']) A.clearLimited(n);
    A.setAutoSwitch({ order: ['sub', 'api'] });
    const viaApi = await L.autoProfile({ loginStatus: no });
    assert.deepEqual([viaApi.env.ANTHROPIC_BASE_URL, viaApi.env.ANTHROPIC_AUTH_TOKEN], [`${url}/as/api`, 'tok'], 'the router address replaces the profile\'s own; the router knows where "api" lives');
    const unknown = await L.autoProfile({ loginStatus: async () => ({ loggedIn: null }) });
    assert.equal(unknown.env.ANTHROPIC_BASE_URL, `${url}/as/sub`, 'when the login state cannot be read, nothing is assumed');
    A.setAutoSwitch({ order: [] });
    assert.equal(await L.autoProfile({ loginStatus: yes }), null);
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
});

test('session defaults become arguments, checked against what Claude Code accepts; later arguments win', async () => {
  const C = await import('../src/config.mjs');
  assert.deepEqual(C.sessionArgs({ sessionDefaults: { permissionMode: 'bypassPermissions', effort: 'high', model: 'opus' } }),
    ['--permission-mode', 'bypassPermissions', '--effort', 'high', '--model', 'opus']);
  assert.deepEqual(C.sessionArgs({ sessionDefaults: { effort: 'high', model: '' } }), ['--effort', 'high']);
  assert.deepEqual(C.sessionArgs({}), []);
  assert.deepEqual(C.sessionArgs({ sessionDefaults: { effort: 'turbo' } }), [], 'a broken setting never blocks a launch');
  assert.deepEqual(C.cleanSessionDefaults({ permissionMode: 'plan', effort: null }), { permissionMode: 'plan' });
  for (const bad of [{ effort: 'turbo' }, { permissionMode: 'yolo' }, { model: 'a b; rm' }, { colour: 'red' }, []]) assert.throws(() => C.cleanSessionDefaults(bad));
  // The session default is first; the config's own extra arguments and the command line come after and win.
  assert.deepEqual(L.dedupeFlags([...C.sessionArgs({ sessionDefaults: { effort: 'high' } }), '--effort', 'low']), ['--effort', 'low']);
});

test('hooks: the kind of failure is kept; "waiting for your input" stays plain waiting', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const id = '55555555-5555-4555-8555-555555555555';
  const hook = (ev) => spawnSync(process.execPath, [binFile(), 'hook'], { input: JSON.stringify({ session_id: id, ...ev }), env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  hook({ hook_event_name: 'Stop', last_assistant_message: 'done' });
  hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.deepEqual([R.readRun(file).status, R.readRun(file).attentionKind], ['waiting', null]);
  hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual([R.readRun(file).status, R.readRun(file).attentionKind], ['attention', 'permission_prompt']);
  hook({ hook_event_name: 'StopFailure', error: 'overloaded', last_assistant_message: 'API Error: Overloaded' });
  let run = R.readRun(file);
  assert.deepEqual([run.failure.error, run.limit ?? null], ['overloaded', null], 'a failure that is not a limit');
  hook({ hook_event_name: 'UserPromptSubmit' });
  run = R.readRun(file);
  assert.deepEqual([run.failure, run.attentionKind, run.status], [null, null, 'working']);
  R.removeRun(file);
});

test('hoprig add offers an OpenAI key (for OpenCode) and saves it as its kind; no Codex sign-in in this version', async () => {
  const { spawn } = await import('node:child_process');
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'hoprig.mjs');
  // Answers each prompt when it shows (a piped stdin: the secret is asked like any line).
  const run = (name, answers) => new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, 'add', name], { env: { ...process.env, HOPRIG_WORKSPACE_DIR: path.join(tmp, 'ws') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    const left = [...answers];
    child.stdout.on('data', (d) => {
      text += d;
      if (left.length && left[0][0].test(text.split('\n').pop())) child.stdin.write(`${left.shift()[1]}\n`);
    });
    child.on('exit', (code) => resolve({ code, text }));
  });
  const a = await run('oai2', [[/^> $/, '5'], [/API key/, 'sk-test-key-123456'], [/Base URL/, 'https://gw.example/v1'], [/Model/, 'gpt-x'], [/Label/, '']]);
  assert.equal(a.code, 0, a.text);
  const o = P.readProfile('oai2');
  assert.deepEqual([o.kind, o.env, o.models, o.label], ['openai', { OPENAI_API_KEY: 'sk-test-key-123456', OPENAI_BASE_URL: 'https://gw.example' }, '*=gpt-x', 'OpenAI API via gw.example']);
  assert.deepEqual(P.servesTools(o), ['codex', 'opencode'], 'the full rule is kept; the pages name the offered tools only');
  assert.match(a.text, /Start OpenCode with: hoprig opencode oai2\./);
  assert.doesNotMatch(a.text, /codex|ChatGPT/i, 'the menu does not offer Codex or its sign-in');
  const b = await run('cx', [[/^> $/, '6']]);
  assert.match(b.text, /Nothing was saved/);
  assert.equal(P.readProfile('cx'), null, 'the Codex sign-in kind is not offered');
  const bad = await run('oai3', [[/^> $/, '5'], [/API key/, 'sk-test-key-123456'], [/Base URL/, ''], [/Model/, '--auto']]);
  assert.match(bad.text, /not a model id/);
  assert.equal(P.readProfile('oai3'), null);
});

test('the command line does not offer Codex: "hoprig codex" is refused in one plain sentence, and the help does not list it', () => {
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'hoprig.mjs');
  const env = { ...process.env, HOPRIG_WORKSPACE_DIR: path.join(tmp, 'ws') };
  for (const args of [['codex'], ['codex', 'login', '--device-auth'], ['tools', 'install', 'codex'], ['tools', 'on', 'codex']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^(hoprig: )?Codex is not part of this version of Hoprig\.\n$/, args.join(' '));
  }
  const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout + help.stderr, /Codex|hoprig codex/);
  assert.match(help.stdout, /hoprig opencode \[provider\]/);
});
