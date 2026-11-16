// The coding-tool descriptors (src/codetools): the enabled-tools setting, the npm install into Hoprig's own tools
// folder (with stand-ins for npm, the program and the registry: nothing is downloaded here), and the switches that
// keep Codex and OpenCode from updating themselves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codetools-'));
Object.assign(process.env, { HOPRIG_STATE_DIR: path.join(tmp, 'state'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg') });
delete process.env.HOPRIG_TOOLS_DIR;
const T = await import('../../src/codetools/index.mjs');
const N = await import('../../src/codetools/npmtool.mjs');
const { codex, CODEX_PIN } = await import('../../src/codetools/codex.mjs');
const { opencode, OPENCODE_PIN, NO_SELF_UPDATE } = await import('../../src/codetools/opencode.mjs');
const { claude } = await import('../../src/codetools/claude.mjs');
const { toolsDir } = await import('../../src/paths.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the three descriptors, and which tools are on', () => {
  assert.deepEqual(T.TOOL_IDS, ['claude', 'codex', 'opencode']);
  assert.equal(T.findTool('codex'), codex);
  assert.equal(T.findTool('nope'), null);
  assert.deepEqual(T.enabledToolIds({}), ['claude'], 'Claude Code alone by default');
  assert.deepEqual(T.enabledToolIds({ codingTools: ['opencode', 'claude', 'bogus'] }), ['claude', 'opencode'], 'fixed order, unknown ids left out');
  assert.deepEqual(T.enabledToolIds({ codingTools: [] }), ['claude'], 'never none');
  assert.deepEqual(T.enabledToolIds({ codingTools: 'codex' }), ['claude'], 'a broken value is the default');
  assert.deepEqual(T.enabledTools({ codingTools: ['codex'] }).map((t) => t.name), ['Codex']);
  assert.throws(() => T.cleanCodingTools([]), /at least one/);
  assert.throws(() => T.cleanCodingTools(['claude', 'gemini']), /"gemini" is not a coding tool/);
  assert.deepEqual(T.withTool({}, 'codex', true), ['claude', 'codex']);
  assert.deepEqual(T.withTool({ codingTools: ['claude', 'codex'] }, 'claude', false), ['codex']);
  assert.throws(() => T.withTool({}, 'claude', false), /at least one/);
  let saved = null;
  T.turnOn('opencode', { config: () => ({ codingTools: ['claude'] }), save: (p) => (saved = p) });
  assert.deepEqual(saved, { codingTools: ['claude', 'opencode'] });
  for (const t of T.TOOLS) for (const k of ['id', 'name', 'home', 'installedVersion', 'info', 'install', 'update', 'updateItem']) assert.ok(k in t, `${t.id}.${k}`);
});

test('Claude Code: the descriptor only points at what exists (the program from config.json, its folder)', () => {
  assert.equal(claude.bin({ claudeBin: '/opt/claude' }), '/opt/claude');
  assert.equal(claude.bin({}), 'claude');
  assert.equal(claude.managed, false);
  assert.equal(claude.updateItem.whenRunning, 'keeps-copy');
});

test('Codex and OpenCode never update themselves when Hoprig starts them', () => {
  assert.equal(CODEX_PIN, '0.169.0');
  assert.equal(OPENCODE_PIN, '2.3.0');
  assert.equal(codex.pkg, '@openai/codex');
  assert.equal(opencode.pkg, '@opencode/cli', 'OpenCode 2, not the old opencode-ai');
  const a = codex.noSelfUpdate.args.join(' ');
  for (const s of ['check_for_update_on_startup=false', 'features.daemon_auto_start=false', 'features.in_app_updates=false']) assert.ok(a.includes(s), s);
  assert.deepEqual({ ...NO_SELF_UPDATE.env }, { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_FREE_MODELS: '1' });
  assert.equal(NO_SELF_UPDATE.config.update, 'disable');
  assert.deepEqual([...NO_SELF_UPDATE.config.disabled_providers], ['opencode'], 'its own free cloud models are off');
  assert.equal(codex.updateItem.whenRunning, 'wait-until-none');
  assert.equal(codex.home({ CODEX_HOME: '/x/codex' }), '/x/codex');
  assert.equal(opencode.home({ XDG_CONFIG_HOME: '/x/cfg' }), path.join('/x/cfg', 'opencode'));
});

test('the newest version comes from the registry, is cached, and is "unknown" when it cannot be had', async () => {
  N.clearLookups();
  let asked = 0;
  const ok = async (u) => {
    asked++;
    assert.equal(u, 'https://registry.npmjs.org/-/package/@openai/codex/dist-tags');
    return { ok: true, text: async () => JSON.stringify({ latest: '0.170.0', alpha: '0.171.0-alpha.1' }) };
  };
  assert.equal(await N.registryLatest('@openai/codex', { fetchImpl: ok, now: 1000 }), '0.170.0');
  assert.equal(await N.registryLatest('@openai/codex', { fetchImpl: ok, now: 2000 }), '0.170.0');
  assert.equal(asked, 1, 'cached');
  N.clearLookups();
  assert.equal(await N.registryLatest('@openai/codex', { fetchImpl: async () => { throw new Error('offline'); } }), null);
  N.clearLookups();
  assert.equal(await N.registryLatest('@openai/codex', { fetchImpl: async () => ({ ok: true, text: async () => '{"latest":"<html>"}' }) }), null, 'never a guess');
  N.clearLookups();
});

/** A stand-in npm that "installs" the package as npm would lay it out, recording how it was called. */
function fakeNpm(tool, { version, binSays = null, fail = false } = {}) {
  const calls = [];
  const run = async (argv, o) => {
    calls.push({ argv, env: o.env, cwd: o.cwd, scratch: fs.readdirSync(tool.dir()).filter((n) => n.startsWith('.install-')) });
    if (fail) return { ok: false, code: 1, output: 'npm error' };
    const pkgDir = path.join(tool.dir(), 'node_modules', ...tool.pkg.split('/'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: tool.pkg, version }));
    fs.mkdirSync(path.dirname(tool.binPath()), { recursive: true });
    fs.writeFileSync(tool.binPath(), '#!/bin/sh\n', { mode: 0o755 });
    o.onLine(`added 1 package`);
    return { ok: true, code: 0, output: '' };
  };
  const check = async (argv, o) => {
    calls.push({ check: argv, env: o.env });
    return { ok: true, stdout: binSays ?? (tool.id === 'codex' ? `codex-cli ${version}\n` : `opencode v${version}\n`), stderr: '' };
  };
  return { run, check, calls };
}

test('install: an npm prefix of its own, the tool\'s folders pointed into a throwaway folder, no provider key passed on', async () => {
  const secretEnv = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test-not-real', OPENAI_API_KEY: 'sk-test-not-real', CODEX_API_KEY: 'x', PATH: process.env.PATH, HOME: '/home/someone' };
  const npm = fakeNpm(opencode, { version: OPENCODE_PIN });
  const lines = [];
  const r = await opencode.install({ run: npm.run, check: npm.check, env: secretEnv, onLine: (l) => lines.push(l) });
  assert.equal(r.ok, true, r.output);
  assert.equal(r.version, OPENCODE_PIN);
  assert.equal(opencode.dir(), path.join(toolsDir(), 'opencode'));
  assert.equal(toolsDir(), path.join(process.env.HOPRIG_STATE_DIR, 'tools'), 'under Hoprig\'s state folder');
  const [inst, ver] = npm.calls;
  assert.deepEqual(inst.argv.slice(-9), ['install', '--prefix', opencode.dir(), '--save-exact', '--no-audit', '--no-fund', '--update-notifier=false', '--omit=optional', `@opencode/cli@${OPENCODE_PIN}`]);
  assert.ok(!inst.argv.includes('-g') && !inst.argv.includes('--global'), 'never global');
  assert.equal(inst.scratch.length, 1, 'a throwaway folder exists while npm runs');
  const scratch = path.join(opencode.dir(), inst.scratch[0]);
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG_DIR', 'TMPDIR']) assert.ok(inst.env[k].startsWith(scratch), `${k} points into the throwaway folder`);
  assert.equal(inst.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  for (const k of N.SECRET_VARS) assert.equal(inst.env[k], undefined, `${k} is not passed to npm`);
  assert.equal(inst.env.HOME, '/home/someone', 'npm keeps its own cache and settings');
  assert.deepEqual(ver.check, [opencode.binPath(), '--version'], 'the new program must answer');
  assert.equal(ver.env.XDG_CONFIG_HOME, inst.env.XDG_CONFIG_HOME, 'and answers inside the throwaway folder too');
  assert.equal(fs.readdirSync(opencode.dir()).filter((n) => n.startsWith('.install-')).length, 0, 'the throwaway folder is gone');
  const pj = JSON.parse(fs.readFileSync(path.join(opencode.dir(), 'package.json'), 'utf8'));
  assert.deepEqual(pj.allowScripts, { [`@opencode/cli@${OPENCODE_PIN}`]: true }, 'exactly its install script may run');
  assert.equal(pj.private, true);
  assert.equal(opencode.installedVersion(), OPENCODE_PIN);
  assert.match(lines.join('\n'), /OpenCode 2\.3\.0 is installed/);
  assert.ok(!lines.join('\n').includes('sk-'), 'no key in the output');
});

test('install: Codex gets its own CODEX_HOME while npm runs, and no install script is allowed', async () => {
  const npm = fakeNpm(codex, { version: CODEX_PIN });
  const r = await codex.install({ run: npm.run, check: npm.check });
  assert.equal(r.ok, true);
  assert.ok(npm.calls[0].env.CODEX_HOME.startsWith(codex.dir()));
  assert.ok(!npm.calls[0].argv.includes('--omit=optional'), 'Codex needs its optional native package');
  assert.equal(JSON.parse(fs.readFileSync(path.join(codex.dir(), 'package.json'), 'utf8')).allowScripts, undefined);
});

test('install: refused versions, a failed npm, and a program that says another version are failures', async () => {
  const lines = [];
  const bad = await codex.install({ version: '1.0; rm -rf ~', onLine: (l) => lines.push(l), run: () => assert.fail('never run') });
  assert.equal(bad.ok, false);
  assert.match(lines[0], /is not a version/);
  const failed = fakeNpm(codex, { fail: true });
  assert.equal((await codex.install({ version: '0.170.0', run: failed.run, check: failed.check })).ok, false);
  const liar = fakeNpm(codex, { version: '0.170.0', binSays: 'codex-cli 0.168.0' });
  const r = await codex.install({ version: '0.170.0', run: liar.run, check: liar.check });
  assert.equal(r.ok, false);
  assert.match(r.output, /says it is 0\.168\.0/);
});

test('info and update: versions from the package and the registry; an update installs the newest, offline changes nothing', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ latest: '0.171.0' }) });
  N.clearLookups();
  const before = await codex.info({ fetchImpl });
  assert.equal(before.method, 'hoprig');
  assert.equal(before.pinned, CODEX_PIN);
  assert.equal(before.latest, '0.171.0');
  assert.equal(before.updateAvailable, before.installed !== null && before.installed !== '0.171.0');
  const npm = fakeNpm(codex, { version: '0.171.0' });
  const r = await codex.update({ fetchImpl, run: npm.run, check: npm.check });
  assert.equal(r.ok, true);
  assert.ok(npm.calls[0].argv.includes('@openai/codex@0.171.0'), 'the exact newest version, not "latest"');
  N.clearLookups();
  const lines = [];
  const off = await codex.update({ fetchImpl: async () => { throw new Error('offline'); }, onLine: (l) => lines.push(l), run: () => assert.fail('nothing runs offline') });
  assert.equal(off.ok, false);
  assert.match(lines[0], /Could not look up the newest Codex/);
  N.clearLookups();
});
