// "Allow everything" in a terminal session, from the dashboard to the hook (src/launchfile.mjs, src/launch.mjs,
// src/allmark.mjs, src/server/deck.mjs): the launch file the dashboard writes is the only thing that puts the mode into
// the process the hook reads (HOPRIG_ALLOW_EVERYTHING); a value inherited from a shell or a profile is removed; a move
// and a restore keep the mode only while the switch and the acknowledgement allow it, and never for a session of Tia's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('allmark');
test.after(() => box.cleanup());
process.env.HOPRIG_TERM_ID = 'pty-1';
const SHOP = path.join(box.home, 'shop');
fs.mkdirSync(SHOP, { recursive: true });

const { saveConfig } = await import('../src/config.mjs');
const { hashPassword } = await import('../src/server/auth.mjs');
const { createServer } = await import('../src/server/server.mjs');
const { writeProfile } = await import('../src/profiles.mjs');
const { conversationOf } = await import('../src/launch.mjs');
const L = await import('../src/launchfile.mjs');
const R = await import('../src/runs.mjs');
const M = await import('../src/allmark.mjs');
const { markHers } = await import('../src/hermark.mjs');
const { readRun } = await import('../src/runfile.mjs');
const { binFile, hookSettingsDir, launchDir, runsDir } = await import('../src/paths.mjs');
const CONV = crypto.randomUUID();

// ---- a move and a restore, through the dashboard ----
const launches = [];
const backend = {
  list: async () => [{ id: 'pty-1', session: 'shop', cwd: SHOP, pid: process.pid, active: true, activity: Date.now(), created: Date.now(), command: 'claude' }],
  capture: async () => '', kind: 'pty', capabilities: {},
  respawn: async (id, dir, argv) => {
    const file = argv[argv.indexOf(L.LAUNCH_FLAG) + 1];
    launches.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    const old = R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1');
    if (old) R.removeRun(path.join(runsDir(), `${old.runId}.json`));
    const l = L.takeLaunch(file);
    const [profile, ...rest] = l.argv;
    R.createRun({ profile, cwd: l.cwd, carryArgs: [], conversation: conversationOf(rest), hand: l.hand || null });
    const now = R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1');
    fs.writeFileSync(path.join(runsDir(), `${now.runId}.json`), JSON.stringify({ ...readRun(path.join(runsDir(), `${now.runId}.json`)), sessionId: CONV, status: 'waiting' }));
  },
};
const BASE = { launcher: ['launcher'], usage: false, server: { roots: [box.home], passwordHash: await hashPassword('right-password') } };
saveConfig(BASE);
writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });
const app = createServer({ backend, watch: false, dashboardFile: false, autoSwitchGraceMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
// A session in Allow everything, as the launcher leaves it: its record, its mark and the arguments Bypass has.
function session({ all = true, hers = false } = {}) {
  for (const r of R.listRuns({ usage: false })) R.removeRun(path.join(runsDir(), `${r.runId}.json`));
  const { file, run } = R.createRun({ profile: 'work', cwd: SHOP, conversation: CONV, carryArgs: ['--permission-mode', 'bypassPermissions'] });
  fs.writeFileSync(file, JSON.stringify({ ...run, sessionId: CONV, status: 'waiting' }));
  if (all) M.markAll(file);
  if (hers) markHers(file);
  launches.length = 0;
}
const move = async () => {
  const r = await call('POST', '/api/sessions/shop/switch', { profile: 'backup' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(launches.length, 1);
  return launches[0];
};

test('a move keeps the mode while the switch and the acknowledgement allow it', () => {
  saveConfig({ ...BASE, allowBypass: true, allowEverythingAt: 5 });
  session();
  return move().then((body) => {
    assert.equal(body.all, true);
    assert.ok(body.argv.includes('bypassPermissions'));
  });
});

test('a move drops it with the switch off, without the acknowledgement, and for a session of Tia', async () => {
  for (const [name, cfg, o] of [
    ['the switch off', { allowBypass: false, allowEverythingAt: 5 }, {}],
    ['not accepted', { allowBypass: true }, {}],
    ['hers', { allowBypass: true, allowEverythingAt: 5 }, { hers: true }],
    ['not marked', { allowBypass: true, allowEverythingAt: 5 }, { all: false }],
  ]) {
    saveConfig({ ...BASE, allowBypass: undefined, allowEverythingAt: undefined, ...cfg });
    session(o);
    const body = await move();
    assert.equal('all' in body, false, name);
  }
});

test('the launch file carries it, once, and refuses a value that is not true', () => {
  const file = L.writeLaunch({ cwd: SHOP, argv: ['work', '--permission-mode', 'bypassPermissions'], all: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).all, true);
  assert.equal(L.takeLaunch(file).all, true);
  assert.equal(fs.existsSync(file), false, 'taken once');
  assert.equal('all' in L.takeLaunch(L.writeLaunch({ cwd: SHOP, argv: ['work'] })), false, 'absent when not asked');
  for (const bad of [false, 'yes', 1]) {
    const f = L.writeLaunch({ cwd: SHOP, argv: ['work'] });
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), all: bad }), { mode: 0o600 });
    assert.throws(() => L.takeLaunch(f), /start line/, String(bad));
  }
});

test('the launcher sets the hook\'s variable from the launch file only, scrubs an inherited one, and marks and unmarks the run', { skip: process.platform === 'win32' && 'the stand-in is POSIX' }, () => {
  const fake = path.join(box.root, 'fake-claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const m = process.env.HOPRIG_RUN_FILE.replace(/[^/]*$/, '');
const markFile = process.env.HOPRIG_HOOK_SETTINGS_DIR + '/' + process.env.HOPRIG_RUN_FILE.split('/').pop() + '.all';
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ all: process.env.HOPRIG_ALLOW_EVERYTHING ?? null, mark: fs.existsSync(markFile) }));
`, { mode: 0o755 });
  saveConfig({ claudeBin: fake, usage: false });
  writeProfile('api', { env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'tok' } });
  const out = path.join(box.root, 'out.json');
  const run = (all, inherited) => {
    fs.rmSync(out, { force: true });
    const file = L.writeLaunch({ cwd: SHOP, argv: ['api'], ...(all ? { all: true } : {}) });
    const r = spawnSync(process.execPath, [binFile(), L.LAUNCH_FLAG, file], { env: { ...process.env, FAKE_OUT: out, HOPRIG_HOOK_SETTINGS_DIR: hookSettingsDir(), ...(inherited ? { HOPRIG_ALLOW_EVERYTHING: '1' } : {}) }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  assert.deepEqual(run(true, false), { all: '1', mark: true }, 'from the launch file');
  assert.deepEqual(run(false, true), { all: null, mark: false }, 'an inherited value is removed');
  assert.deepEqual(run(false, false), { all: null, mark: false });
  assert.deepEqual(fs.readdirSync(hookSettingsDir()).filter((n) => n.endsWith('.all')), [], 'no mark outlives its run');
});


test('what Allow everything allowed reaches the session card marked by all, for the quiet line', async () => {
  saveConfig({ ...BASE, allowBypass: true, allowEverythingAt: 5 });
  session();
  const run = R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1');
  const file = path.join(runsDir(), `${run.runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), allowed: [{ n: 1, at: Date.now(), tool: 'Bash', what: 'ls', by: 'all' }, { n: 2, at: Date.now(), tool: 'Bash', what: 'pwd' }] }));
  const st = await call('GET', '/api/state');
  const card = st.json.sessions.find((s) => s.name === 'shop');
  assert.deepEqual(card.allowed.map((a) => [a.what, a.by]), [['ls', 'all'], ['pwd', undefined]]);
});
