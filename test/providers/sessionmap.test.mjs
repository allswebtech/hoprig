// The map for every session (src/providers/sessionmap.mjs): a plain session and a chat of a profile with MODELS get its
// renames through the coding tool's own setting, the owner's own modelOverrides are copied in and win for a name both
// map, the small model goes into ANTHROPIC_DEFAULT_HAIKU_MODEL of that session only, his settings file is never
// written, and a session of another profile gets that profile's map. Made-up gateway names ("relay-…").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { mapEnv, mapSettings, ownOverrides, sessionMap } from '../../src/providers/sessionmap.mjs';
import { sandbox } from '../server/helpers.mjs';

// Folders of its own: the check reads the installed Claude Code and the owner's modelOverrides, and another test file
// that runs at the same time writes both into the runner's shared folders.
const box = sandbox('providers-sessionmap');
test.after(() => box.cleanup());

// The switch on (MAPSESSIONS=on): these tests are about what a session gets once the owner turned the map on.
const relay = (models, env = {}) => ({ name: 'relay-a', kind: 'api', models, mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/relay', ANTHROPIC_API_KEY: 'made-up-key-0000', ...env } });

test('a profile with MODELS renames the large names; the small model gets its own variable', () => {
  const m = sessionMap(relay('claude-opus-*=relay-large,claude-haiku-*=relay-small'), { own: {} });
  assert.equal(m.overrides['claude-opus-5-5'], 'relay-large');
  assert.equal(m.overrides['claude-opus-5'], 'relay-large', 'a name the tool falls back to is mapped too');
  assert.ok(!Object.keys(m.overrides).some((n) => /haiku/.test(n)), 'the tool does not rename the small model this way');
  assert.equal(m.haiku, 'relay-small');
  assert.deepEqual(mapEnv({}, m), { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay-small' });
  assert.deepEqual(mapEnv({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mine' }, m), { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mine' });
  // A literal name of a rule is mapped too.
  assert.equal(sessionMap(relay('relay-old=relay-new'), { own: {} }).overrides['relay-old'], 'relay-new');
});

test('a key paid per use with a chosen model sends its other names under their own names', () => {
  // What Providers -> save writes for a key straight to the provider's own API with a model chosen.
  const direct = { name: 'direct', kind: 'api', models: '*=claude-opus-5-5', mapSessions: true, env: { ANTHROPIC_API_KEY: 'made-up-key-0000', ANTHROPIC_MODEL: 'claude-opus-5-5' } };
  const m = sessionMap(direct, { own: {} });
  assert.deepEqual([m.overrides, m.haiku, m.rules], [null, null, []], 'no small-model or sonnet call is sent to the chosen model');
  assert.deepEqual(mapEnv({}, m), {});
  // An explicit name rule of his still maps there.
  const named = sessionMap({ ...direct, models: '*=claude-opus-5-5,claude-opus-5=claude-opus-5-5' }, { own: {} });
  assert.deepEqual(named.overrides, { 'claude-opus-5': 'claude-opus-5-5' });
  // Through a gateway the bare rule maps as Auto mode's router does.
  const gw = sessionMap({ ...direct, models: '*=relay-large', env: { ...direct.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/relay' } }, { own: {} });
  assert.equal(gw.overrides['claude-sonnet-5-5'], 'relay-large');
});

test("the owner's own entries are copied in, and his entry wins for a name both map", () => {
  const m = sessionMap(relay('claude-opus-*=relay-large'), { own: { 'claude-opus-5-5': 'owner-large', 'claude-sonnet-5-5': 'owner-mid' } });
  assert.equal(m.overrides['claude-opus-5-5'], 'owner-large');
  assert.equal(m.overrides['claude-sonnet-5-5'], 'owner-mid');
  assert.equal(m.overrides['claude-opus-4-8'], 'relay-large');
  assert.deepEqual(m.rules.filter((r) => r.by === 'yours').map((r) => r.from), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.ok(!m.rules.some((r) => r.by === 'profile' && r.from === 'claude-opus-5-5'));
});

test('no map for a profile without MODELS, for Auto mode (its router maps), or for an older Claude Code', () => {
  assert.equal(sessionMap(relay(''), { own: { a: 'b' } }).overrides, null);
  assert.equal(sessionMap({ name: 'auto', kind: 'auto', router: true, models: '*=x', env: {} }).overrides, null);
  const m = sessionMap(relay('claude-opus-*=relay-large'), { own: {} });
  assert.deepEqual(mapSettings(m, '2.1.300'), {});
  assert.deepEqual(mapSettings(m, null), {});
  assert.deepEqual(Object.keys(mapSettings(m, '2.1.328')), ['modelOverrides']);
});

test("a profile with a Claude Code folder of its own gets that folder's entries, never the default folder's", async () => {
  const { claudeDir } = await import('../../src/paths.mjs');
  const other = path.join(process.env.HOME, 'claudeB');
  for (const [dir, model] of [[claudeDir(), 'acct-a-model'], [other, 'acct-b-model']]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelOverrides: { 'claude-opus-5-5': model } }));
  }
  const b = relay('claude-opus-5=relay-large', { CLAUDE_CONFIG_DIR: other });
  assert.deepEqual(mapSettings(sessionMap(b), '2.1.328').modelOverrides, { 'claude-opus-5': 'relay-large', 'claude-opus-5-5': 'acct-b-model' });
  assert.equal(sessionMap(relay('claude-opus-5=relay-large')).overrides['claude-opus-5-5'], 'acct-a-model', 'the default folder for a profile without one');
  fs.rmSync(path.join(claudeDir(), 'settings.json'));
});

test("the owner's settings are read only, and an odd entry is left out", () => {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'odd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelOverrides: { 'claude-opus-5-5': 'owner-large', bad: 7, '-x': 'y' } }));
  assert.deepEqual(ownOverrides(dir), { 'claude-opus-5-5': 'owner-large' });
  assert.deepEqual(ownOverrides(path.join(dir, 'none')), {});
});

// A stand-in Claude Code where its version is read from (…/claude/versions/<version>): it writes down its settings and
// its environment. It is started by the real launcher (`hoprig <profile>`).
function fakeClaude() {
  const base = process.env.HOPRIG_STATE_DIR || process.env.HOME;
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'fake-'));
  const bin = path.join(root, 'claude', 'versions', '2.1.328');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const i = process.argv.indexOf('--settings');
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ settings: JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')), haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null, base: process.env.ANTHROPIC_BASE_URL ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, profile: process.env.HOPRIG_PROFILE }));
`, { mode: 0o755 });
  return { root, bin };
}

test('a plain session of a mapped profile gets the map in its settings file; his settings file stays the same byte for byte; a moved session gets the other profile\'s map only', { skip: process.platform === 'win32' && 'the stand-in is started through its #! line' }, async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { binFile, claudeDir } = await import('../../src/paths.mjs');
  const { saveConfig } = await import('../../src/config.mjs');
  const { root, bin } = fakeClaude();
  saveConfig({ claudeBin: bin, usage: false });
  fs.mkdirSync(claudeDir(), { recursive: true });
  const own = path.join(claudeDir(), 'settings.json');
  fs.writeFileSync(own, `${JSON.stringify({ modelOverrides: { 'claude-opus-5-5': 'owner-large' }, theme: 'light' }, null, 2)}\n`);
  const before = fs.readFileSync(own);
  writeProfile('relay-a', { label: 'Relay A', models: 'claude-opus-*=relay-large,claude-haiku-*=relay-small', mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/a', ANTHROPIC_API_KEY: 'made-up-key-aaaa' } });
  writeProfile('relay-b', { label: 'Relay B', models: 'claude-sonnet-*=relay-mid', mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/b', ANTHROPIC_API_KEY: 'made-up-key-bbbb' } });
  const run = (name) => {
    const out = path.join(root, `${name}.json`);
    const r = spawnSync(process.execPath, [binFile(), name, '-p', 'hi'], { env: { ...process.env, FAKE_OUT: out }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  const a = run('relay-a');
  assert.equal(a.settings.modelOverrides['claude-opus-4-8'], 'relay-large');
  assert.equal(a.settings.modelOverrides['claude-opus-5-5'], 'owner-large', 'his entry wins');
  assert.ok(a.settings.hooks.StopFailure, 'beside the hook, in the same file');
  assert.equal(a.haiku, 'relay-small');
  assert.deepEqual([a.base, a.key, a.profile], ['http://127.0.0.1:9/a', 'made-up-key-aaaa', 'relay-a'], 'the address, the key and the profile are the profile\'s own');
  const b = run('relay-b');
  assert.equal(b.settings.modelOverrides['claude-sonnet-5'], 'relay-mid');
  assert.ok(!Object.values(b.settings.modelOverrides).includes('relay-large'), 'nothing of the other profile\'s map');
  assert.equal(b.haiku, null);
  assert.equal(b.base, 'http://127.0.0.1:9/b');
  assert.ok(fs.readFileSync(own).equals(before), 'his settings file is the same byte for byte');
});

test("a chat of a mapped profile gets the same map, in its settings and its environment", async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { claude } = await import('../../src/chat/engines/claude.mjs');
  writeProfile('relay-c', { models: 'claude-opus-*=relay-large,claude-haiku-4-5=relay-small', mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/c', ANTHROPIC_API_KEY: 'made-up-key-cccc' } });
  const seen = [];
  const spawnImpl = (command, args, opts) => {
    seen.push({ args, env: opts.env });
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, kill: () => true });
    return child;
  };
  const s = claude.open({ cwd: process.env.HOME, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/c' }, profile: 'relay-c', sessionId: '5e551011-0000-4000-8000-000000000003', resume: false, model: null, mode: 'default', grants: [], version: '2.1.328', command: { command: 'x', args: [] }, spawnImpl, emit: () => {} });
  const { args, env } = seen[0];
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.modelOverrides['claude-opus-5'], 'relay-large');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'relay-small');
  s.close?.();
  // A chat on Auto mode gets none: its router maps.
  seen.length = 0;
  claude.open({ cwd: process.env.HOME, env: {}, profile: 'auto', sessionId: '5e551011-0000-4000-8000-000000000004', resume: false, model: null, mode: 'default', grants: [], version: '2.1.328', command: { command: 'x', args: [] }, spawnImpl, emit: () => {} }).close?.();
  assert.ok(!seen[0].args.includes('--settings') || !/modelOverrides/.test(seen[0].args[seen[0].args.indexOf('--settings') + 1]));
});

test('with MODELS and the switch off, a terminal session, its agents and a chat get no rename and no small model; the command turns it on', { skip: process.platform === 'win32' && 'the stand-in is started through its #! line' }, async () => {
  const { writeProfile, readProfile } = await import('../../src/profiles.mjs');
  const { binFile } = await import('../../src/paths.mjs');
  const { saveConfig } = await import('../../src/config.mjs');
  const { claude } = await import('../../src/chat/engines/claude.mjs');
  const { root, bin } = fakeClaude();
  saveConfig({ claudeBin: bin, usage: false });
  writeProfile('relay-off', { label: 'Relay Off', models: 'claude-opus-*=relay-large,claude-haiku-*=relay-small', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/off', ANTHROPIC_API_KEY: 'made-up-key-ffff' } });
  const run = () => {
    const out = path.join(root, 'off.json');
    const r = spawnSync(process.execPath, [binFile(), 'relay-off', '-p', 'hi'], { env: { ...process.env, FAKE_OUT: out }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  // A profile as it is before the update: MODELS for Auto mode, no switch. The settings file (which the session's
  // agents read too) has its hooks and no modelOverrides; the environment names no small model.
  const off = run();
  assert.ok(off.settings.hooks.StopFailure);
  assert.equal(off.settings.modelOverrides, undefined);
  assert.equal(off.haiku, null);
  const seen = [];
  const spawnImpl = (command, args, opts) => {
    seen.push({ args, env: opts.env });
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, kill: () => true });
    return child;
  };
  const chat = () => claude.open({ cwd: process.env.HOME, env: {}, profile: 'relay-off', sessionId: '5e551011-0000-4000-8000-000000000009', resume: false, model: null, mode: 'default', grants: [], version: '2.1.328', command: { command: 'x', args: [] }, spawnImpl, emit: () => {} });
  chat().close?.();
  const given = seen[0].args.includes('--settings') ? seen[0].args[seen[0].args.indexOf('--settings') + 1] : '{}';
  assert.doesNotMatch(given, /modelOverrides/);
  assert.equal(seen[0].env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  // The command: without a terminal and without --yes nothing changes; with --yes it is on.
  const cmd = (...a) => spawnSync(process.execPath, [binFile(), 'profiles', 'map', ...a], { env: process.env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const show = cmd('relay-off');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /is OFF for sessions and chats/);
  // An earlier test of this file keeps an owner's entry for claude-opus-5-5: his entry is said as his.
  assert.match(show.stdout, /claude-opus-5 -> relay-large\n/);
  assert.match(show.stdout, /claude-opus-5-5 -> owner-large  \(from your own Claude Code settings\)/);
  assert.equal(cmd('relay-off', 'on').status, 2);
  assert.equal(readProfile('relay-off').mapSessions, false);
  assert.equal(cmd('relay-off', 'on', '--yes').status, 0);
  assert.equal(readProfile('relay-off').mapSessions, true);
  assert.equal(readProfile('relay-off').env.ANTHROPIC_API_KEY, 'made-up-key-ffff', 'the key stays');
  const on = run();
  assert.equal(on.settings.modelOverrides['claude-opus-5'], 'relay-large');
  assert.equal(on.haiku, 'relay-small');
  seen.length = 0;
  chat().close?.();
  assert.equal(JSON.parse(seen[0].args[seen[0].args.indexOf('--settings') + 1]).modelOverrides['claude-opus-5'], 'relay-large');
  assert.equal(seen[0].env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'relay-small');
  assert.equal(cmd('relay-off', 'off').status, 0);
  assert.equal(readProfile('relay-off').mapSessions, false);
  assert.equal(cmd('relay-nobody').status, 1);
  assert.equal(cmd().status, 2);
});

test("a chat gets the map whichever way its settings reach Claude Code: in the file with its hooks or extra folders, or as the settings argument", async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { claude } = await import('../../src/chat/engines/claude.mjs');
  writeProfile('relay-w', { models: 'claude-opus-*=relay-large,claude-haiku-*=relay-small', mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/w', ANTHROPIC_API_KEY: 'made-up-key-wwww' } });
  const seen = [];
  const spawnImpl = (command, args, opts) => {
    seen.push({ args, env: opts.env });
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, kill: () => true });
    return child;
  };
  const settingsOf = (args) => {
    const v = args[args.indexOf('--settings') + 1];
    return v.trim().startsWith('{') ? JSON.parse(v) : JSON.parse(fs.readFileSync(v, 'utf8'));
  };
  const runFile = path.join(process.env.HOPRIG_STATE_DIR, 'chat-w.json');
  const extras = { settings: { additionalDirectories: ['/work/shared'], deny: ['Read(/work/shared/.env)'] } };
  const open = (o) => claude.open({ cwd: process.env.HOME, env: {}, profile: 'relay-w', sessionId: '5e551011-0000-4000-8000-00000000000a', resume: false, model: null, mode: 'default', grants: [], command: { command: 'x', args: [] }, spawnImpl, emit: () => {}, ...o });
  // A record and a Claude Code that knows the hook: one file with the hooks, the extra folders and the map.
  open({ runFile, version: '2.1.328', extras }).close?.();
  let s = settingsOf(seen.at(-1).args);
  assert.ok(s.hooks.StopFailure);
  assert.deepEqual(s.permissions.additionalDirectories, ['/work/shared']);
  assert.equal(s.modelOverrides['claude-opus-5'], 'relay-large');
  // No record (no hooks, no file): the map goes as the settings argument.
  open({ version: '2.1.328' }).close?.();
  s = settingsOf(seen.at(-1).args);
  assert.equal(s.hooks, undefined);
  assert.equal(s.modelOverrides['claude-opus-5'], 'relay-large');
  // A record and a Claude Code too old for the hook's events (2.1.319): it is older than the version the map was read
  // from (2.1.328) too, so only the small model's name reaches it, in its environment.
  open({ runFile, version: '2.1.300' }).close?.();
  assert.doesNotMatch(seen.at(-1).args.join(' '), /modelOverrides/);
  assert.equal(seen.at(-1).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'relay-small');
});

test("Auto mode's router maps a provider's MODELS the same with the switch off and on", async () => {
  const R = await import('../../src/router.mjs');
  const sent = { rest: '/v1/messages', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: [] })) };
  const sends = (p) => JSON.parse(String(R.upstreamRequest(p, { ...sent, isIdentity: false }).body)).model;
  const on = relay('claude-opus-*=relay-large');
  assert.equal(sends({ ...on, mapSessions: false }), 'relay-large');
  assert.equal(sends(on), 'relay-large');
  assert.equal(sessionMap({ ...on, mapSessions: false }).overrides, null, 'a session gets nothing while it is off');
});
