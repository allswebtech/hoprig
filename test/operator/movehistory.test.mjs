// "Never back to a provider the session left within the hour" sees every move of a session: what the product records of
// a session's runs (runs.mjs: which provider each run of a conversation was on, until when), written where a run record
// is rewritten for another provider or removed. This file drives the launcher's own move for real: a stand-in Claude
// Code in a pseudo-terminal stops at a usage limit, Auto mode (the launcher's own, without the dashboard) moves it on.
// Traps stand first on PATH for the programs a test must never reach.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-movehistory');
test.after(() => box.cleanup());

const TRAPPED = ['sudo', 'npm', 'systemctl', 'loginctl', 'apt-get', 'brew', 'ssh', 'git'];
const traps = path.join(box.root, 'traps');
const trapLog = path.join(box.root, 'trap.log');
fs.mkdirSync(traps);
for (const n of TRAPPED) fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapLog}'\nexit 97\n`, { mode: 0o755 });

const { binFile } = await import('../../src/paths.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { setAutoSwitch } = await import('../../src/autoswitch.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { ranBefore } = await import('../../src/runs.mjs');

test('the launcher\'s own move at a limit is recorded: the conversation ran on the first provider until the move', { skip: process.platform === 'win32' }, async () => {
  const pty = (await import('node-pty')).default ?? (await import('node-pty'));
  const id = '5a5a5a5a-1111-4222-8333-444444444444';
  const out = path.join(box.root, 'fake-runs.log');
  // The stand-in: on its first provider it reports a limit in its run record (as Claude Code's hook does) and waits to
  // be stopped; on the next one it ends by itself.
  const fake = path.join(box.root, 'fake-claude.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const file = process.env.HOPRIG_RUN_FILE;
fs.appendFileSync(${JSON.stringify(out)}, process.env.HOPRIG_PROFILE + ' ' + process.argv.slice(2).join(' ') + '\\n');
if (process.env.HOPRIG_PROFILE === 'plan-a') {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...run, sessionId: ${JSON.stringify(id)}, status: 'attention', limit: { at: Date.now(), error: 'rate_limit', text: 'Usage limit reached' } }));
  setInterval(() => {}, 1000);
} else process.exit(0);
`, { mode: 0o755 });
  saveConfig({ claudeBin: fake, usage: false });
  writeProfile('plan-a', { label: 'Shop Plan A', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-a' } });
  writeProfile('plan-b', { label: 'Shop Plan B', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-b' } });
  setAutoSwitch({ enabled: true, order: ['plan-a', 'plan-b'] });
  const env = { ...process.env, PATH: `${traps}${path.delimiter}${process.env.PATH}` };
  delete env.HOPRIG_RUN_FILE;
  const p = pty.spawn(process.execPath, [binFile(), 'plan-a', '--session-id', id], { cwd: box.home, env, cols: 100, rows: 30 });
  let screen = '';
  p.onData((d) => { screen += d; });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error(`the launcher did not end:\n${screen}`)); }, 30_000);
    p.onExit(({ exitCode }) => { clearTimeout(t); resolve(exitCode); });
  });
  assert.equal(code, 0, screen);
  // Named as the Providers page names them: by their labels.
  assert.match(screen, /Shop Plan A reached its usage limit\. Continuing this session on Shop Plan B\./, screen);
  assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]), ['plan-a', 'plan-b'], 'the same session went on under plan-b');
  const ran = ranBefore().filter((r) => r.conversation === id).map((r) => r.profile);
  assert.deepEqual(ran.slice(0, 1), ['plan-a'], `the record says it ran on plan-a until the move: ${JSON.stringify(ranBefore())}`);
  assert.equal(fs.existsSync(trapLog), false, `a trapped program was called: ${fs.existsSync(trapLog) ? fs.readFileSync(trapLog, 'utf8') : ''}`);
});
