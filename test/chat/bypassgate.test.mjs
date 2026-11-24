// "Allow bypass permissions mode" (src/bypassgate.mjs, src/server/bypass.mjs): off, Bypass permissions is offered
// nowhere, refused and the App's process starts without the flag that allows it; the one-time step keeps it on for a
// dashboard that used it before the switch existed. And "Always allow in this project", through Claude Code's own
// destination for a project's local settings.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('bypassgate');
test.after(() => box.cleanup());
const G = await import('../../src/bypassgate.mjs');
const { bypassFeature } = await import('../../src/server/bypass.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { chatArgs, sessionGrant } = await import('../../src/chat/engines/claude-lines.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');

const cfgFile = () => path.join(box.config, 'config.json');
const writeCfg = (o) => fs.writeFileSync(cfgFile(), JSON.stringify(o, null, 2));
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function feature(o = {}) {
  const bodies = [];
  const ctx = { config: loadConfig, saveConfig, HttpError, readJson: async () => bodies.shift() || {}, poke() {} };
  // Each feature is a dashboard of its own: its own marker of the one-time step.
  const f = bypassFeature(ctx, { chatsFile: path.join(box.state, 'chats.json'), runs: () => [], marker: path.join(box.state, `first-look-${crypto.randomUUID()}.json`), ...o });
  const route = (method, p) => f.routes.find(([m, re]) => m === method && re.test(p))[2];
  return { f, call: (method, p, body) => (bodies.push(body), route(method, p)()) };
}

test('the one-time step on a home as 0.3.2 leaves it: bypass in the session defaults keeps the switch on, said once', async () => {
  writeCfg({ claudeBin: 'claude', sessionDefaults: { permissionMode: 'bypassPermissions', effort: 'high' }, server: { port: 7433 } });
  const { f, call } = feature();
  f.start();
  const c = readCfg();
  assert.equal(c.allowBypass, true);
  assert.ok(Number.isFinite(c.bypassKept), 'Home says it once');
  assert.deepEqual(c.sessionDefaults, { permissionMode: 'bypassPermissions', effort: 'high' }, 'nothing else changes');
  assert.equal(c.server.port, 7433);
  const v = await call('GET', '/api/settings/bypass');
  assert.equal(v.allow, true);
  assert.equal(v.kept, c.bypassKept);
  await call('POST', '/api/settings/bypass/seen', {});
  assert.equal((await call('GET', '/api/settings/bypass')).kept, null, 'read once: it goes');
  f.start();
  assert.equal(readCfg().allowBypass, true, 'the step runs once: a later start changes nothing');
});

test('the one-time step on a home without bypass in its defaults, and on a new install: off, and the file untouched', async () => {
  writeCfg({ sessionDefaults: { permissionMode: 'acceptEdits' } });
  const before = fs.readFileSync(cfgFile(), 'utf8');
  const { f, call } = feature();
  f.start();
  assert.equal(fs.readFileSync(cfgFile(), 'utf8'), before, 'the config file stays as the released version left it');
  assert.deepEqual(await call('GET', '/api/settings/bypass'), { allow: false, kept: null, terminals: 0 }, 'off, nothing to say on Home');
  f.start();
  assert.equal(fs.readFileSync(cfgFile(), 'utf8'), before, 'a later start finds the same');
  fs.rmSync(cfgFile());
  feature().f.start();
  assert.ok(!fs.existsSync(cfgFile()) || readCfg().allowBypass !== true, 'a new install: off');
  assert.equal(G.bypassAllowed(loadConfig()), false);
});

test('the one-time step is done once: a terminal started in bypass months later does not turn the switch on', () => {
  const marker = path.join(box.state, 'first-look-test.json');
  writeCfg({ sessionDefaults: { permissionMode: 'acceptEdits' } });
  const before = fs.readFileSync(cfgFile(), 'utf8');
  // Day one: nothing used bypass. Off, the config untouched; the marker says the step was done.
  assert.deepEqual(G.firstLook({ cfg: loadConfig(), save: saveConfig, runs: () => [], marker }), { allow: false, why: [] });
  assert.equal(fs.readFileSync(cfgFile(), 'utf8'), before);
  assert.ok(fs.existsSync(marker));
  // Later the owner runs `hoprig claude --dangerously-skip-permissions` in a terminal; the next start looks no more.
  assert.equal(G.firstLook({ cfg: loadConfig(), save: () => assert.fail('no write'), runs: () => [{ carryArgs: ['--dangerously-skip-permissions'] }], marker }), null);
  assert.equal(G.bypassAllowed(loadConfig()), false, 'the switch stays off');
  fs.rmSync(marker);
  // The config's own arguments for every launch are looked at too.
  assert.deepEqual(G.firstLook({ cfg: { claudeArgs: ['--dangerously-skip-permissions'] }, save: () => {}, marker }), { allow: true, why: ['config'] });
  fs.rmSync(marker);
});

test('the one-time step also keeps it for an open App session or a running terminal in bypass', () => {
  const chats = path.join(box.state, 'chats.json');
  writeCfg({});
  fs.writeFileSync(chats, JSON.stringify([{ id: crypto.randomUUID(), cwd: '/w/a', profile: 'p', permissionMode: 'manual' }, { id: crypto.randomUUID(), cwd: '/w/b', profile: 'p', permissionMode: 'bypassPermissions' }]));
  assert.deepEqual(G.firstLook({ cfg: loadConfig(), save: saveConfig, chatsFile: chats }), { allow: true, why: ['app'] });
  writeCfg({});
  fs.rmSync(chats);
  assert.deepEqual(G.firstLook({ cfg: loadConfig(), save: saveConfig, chatsFile: chats, runs: () => [{ carryArgs: ['--permission-mode', 'bypassPermissions'] }] }), { allow: true, why: ['terminal'] });
  for (const args of [['--dangerously-skip-permissions'], ['--permission-mode=bypassPermissions']]) assert.equal(G.bypassInArgs(args), true);
  assert.equal(G.bypassInArgs(['--permission-mode', 'auto']), false);
  assert.equal(G.firstLook({ cfg: { allowBypass: false, sessionDefaults: { permissionMode: 'bypassPermissions' } }, save: () => assert.fail('no write') }), null, 'a decided switch is never changed by it');
});

test('on only with a confirmation; off takes bypass out of the defaults and puts the open App sessions in Manual', async () => {
  writeCfg({ allowBypass: false, sessionDefaults: { permissionMode: 'bypassPermissions', model: 'opus' } });
  let off = 0;
  const { call } = feature({ chat: { bypassOff: async () => (off++, 2) } });
  await assert.rejects(call('POST', '/api/settings/bypass', { allow: true }), /confirmation/);
  assert.equal(readCfg().allowBypass, false);
  assert.equal((await call('POST', '/api/settings/bypass', { allow: true, confirm: true })).allow, true);
  const r = await call('POST', '/api/settings/bypass', { allow: false });
  assert.deepEqual([r.allow, r.changed, r.defaults, off], [false, 2, true, 1]);
  assert.deepEqual(readCfg().sessionDefaults, { model: 'opus' });
  await assert.rejects(call('POST', '/api/settings/bypass', { allow: 'yes' }), /allow/);
});

test('the mode lists and the App\'s process: no Bypass and no flag that allows it while the switch is off', () => {
  const modes = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];
  assert.deepEqual(G.gateModes(modes, { allowBypass: false }), modes.slice(0, 5));
  assert.deepEqual(G.gateModes(modes, {}), modes.slice(0, 5), 'undecided counts as off');
  assert.deepEqual(G.gateModes(modes, { allowBypass: true }), modes);
  const off = chatArgs({ sessionId: 's', permissionMode: 'bypassPermissions', allowBypass: false });
  assert.ok(!off.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!off.includes('bypassPermissions'), 'a bypass start mode is not given either');
  assert.ok(chatArgs({ sessionId: 's', permissionMode: 'acceptEdits', allowBypass: false }).includes('acceptEdits'));
  assert.ok(chatArgs({ sessionId: 's', allowBypass: true }).includes('--allow-dangerously-skip-permissions'));
});

test('a chat on a dashboard with the switch off starts Claude Code without the flag, and cannot switch to bypass', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(box.root, 'gate.args');
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', permissionMode: 'manual', allowBypass: () => false, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }) });
  t.after(() => c.stopAndWait());
  const done = new Promise((r) => c.once('turn', r));
  await c.send('hello');
  await done;
  const start = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray)[0];
  assert.ok(!start.includes('--allow-dangerously-skip-permissions'));
  // Claude Code itself refuses bypass in a process started without the flag (the stand-in does as it does).
  await c.setSettings({ mode: 'bypassPermissions' });
  assert.notEqual(c.liveMode, 'bypassPermissions');
});

test('"Always allow in this project": the same rules with Claude Code\'s localSettings destination; "all edits" alone has none', async (t) => {
  const g = sessionGrant([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
  assert.deepEqual(g.project, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ], 'the rule kept in the project, "all edits" for this session (a mode is not kept in a file), as the card says');
  assert.equal(g.projectText, 'Bash(npm view *)', 'the project answer names only what it keeps');
  assert.deepEqual(g.projectAtoms, ['mode:acceptEdits']);
  assert.equal(sessionGrant([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]).project, null);
  // Only what Claude Code itself offers to keep: a rule or folder it suggests for the session stays a session grant.
  assert.equal(sessionGrant([{ type: 'addDirectories', directories: ['/srv/data'], destination: 'session' }]).project, null);
  assert.equal(sessionGrant([{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/srv/**' }], behavior: 'allow', destination: 'session' }]).project, null);
  assert.equal(sessionGrant([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }], behavior: 'allow', destination: 'userSettings' }]).project, null, 'the owner\'s user settings are not this project');
  const mixed = sessionGrant([
    { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.org' }], behavior: 'allow', destination: 'projectSettings' },
  ]);
  assert.deepEqual(mixed.project, [{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.org' }], behavior: 'allow', destination: 'localSettings' }], 'the folder is not kept; the rule goes to the local file, not the shared one');
  assert.equal(mixed.projectText, 'WebFetch(domain:example.org)');
  // Through a chat: the card offers it, and the answer carries the rule to Claude Code with that destination.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(box.root, 'project.args');
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', permissionMode: 'manual', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }) });
  t.after(() => c.stopAndWait());
  const done = new Promise((r) => c.once('turn', r));
  await c.send('run npm view left-pad');
  const end = Date.now() + 10_000;
  let ask;
  while (!(ask = c.events.find((e) => e.kind === 'ask')) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(ask.canProject, true);
  c.answer(ask.request, { allow: true, always: 'project' });
  await done;
  const answer = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.answer).at(-1).answer;
  assert.deepEqual(answer.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }], behavior: 'allow', destination: 'localSettings' }]);
  assert.equal(c.events.filter((e) => e.kind === 'ask-closed').at(-1).outcome, 'allowed-project');
  assert.equal(c.grants.size, 0, 'nothing kept in the chat: Claude Code keeps it in the project');
  assert.ok(!fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), 'Hoprig itself writes no settings file (the stand-in keeps the rule in memory)');
});

test('off reaches the terminal sessions too: a move or a restore starts them without bypass; Settings counts the ones running', async () => {
  const args = ['--model', 'opus', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions', '--verbose'];
  assert.deepEqual(G.withoutBypass(args), ['--model', 'opus', '--verbose']);
  assert.deepEqual(G.gateCarry(args, { allowBypass: true }), args, 'on: kept as started');
  assert.deepEqual(G.gateCarry(args, {}), ['--model', 'opus', '--verbose']);
  assert.deepEqual(G.withoutBypass(['--permission-mode', 'acceptEdits']), ['--permission-mode', 'acceptEdits']);
  // The deck's move (Auto mode's switch, Move to another provider) and the restore after a restart both go through it.
  const { Deck } = await import('../../src/server/deck.mjs');
  let cfg = { launcher: ['hop'], allowBypass: false };
  const deck = new Deck({ backend: {}, config: () => cfg, profiles: () => [] });
  const run = { sessionId: '11111111-2222-3333-4444-555555555555', cwd: box.root, carryArgs: ['--dangerously-skip-permissions', '--effort', 'high'] };
  const moved = deck.moveArgv({ name: 'work', env: {} }, run);
  assert.ok(!moved.includes('--dangerously-skip-permissions'), moved.join(' '));
  assert.ok(moved.includes('--effort'));
  cfg = { launcher: ['hop'], allowBypass: true };
  assert.ok(deck.moveArgv({ name: 'work', env: {} }, run).includes('--dangerously-skip-permissions'), 'on: the move keeps it');
  const src = fs.readFileSync(new URL('../../src/automation/feature.mjs', import.meta.url), 'utf8');
  assert.match(src, /carryArgs: gateCarry\(carryArgs, sctx\.config\?\.\(\)\)/, 'the restore\'s start too');
  // Settings: how many terminal sessions run in bypass now.
  writeCfg({ allowBypass: false });
  const { call } = feature({ runs: () => [{ carryArgs: ['--dangerously-skip-permissions'] }, { carryArgs: ['--model', 'opus'] }, { carryArgs: ['--permission-mode', 'bypassPermissions'] }] });
  assert.equal((await call('GET', '/api/settings/bypass')).terminals, 2);
});

test('as root, Home is never told bypass permissions mode "stays allowed": the one-time step keeps nothing there', async () => {
  writeCfg({ claudeBin: 'claude', sessionDefaults: { permissionMode: 'bypassPermissions' }, allowBypass: true, bypassKept: Date.now(), server: { port: 7433 } });
  const ctx = { config: loadConfig, saveConfig, HttpError, readJson: async () => ({}), poke() {}, root: true };
  const f = bypassFeature(ctx, { chatsFile: path.join(box.state, 'chats.json'), runs: () => [], marker: path.join(box.state, `first-look-${crypto.randomUUID()}.json`) });
  const view = await f.routes.find(([m, re]) => m === 'GET' && re.test('/api/settings/bypass'))[2]();
  assert.equal(view.allow, false);
  assert.equal(view.kept, null, 'no note on Home');
});
